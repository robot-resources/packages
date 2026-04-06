import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..');

// ── SDK Contract Tests ─────────────────────────────────────────
// These tests validate that our plugin matches the REAL OpenClaw SDK
// surface. If these break, it means our assumptions about the SDK
// changed — NOT that our code is wrong.

describe('OpenClaw SDK contract: manifest', () => {
  let manifest;

  beforeEach(() => {
    const raw = readFileSync(join(PLUGIN_ROOT, 'openclaw.plugin.json'), 'utf-8');
    manifest = JSON.parse(raw);
  });

  it('has required id field (string)', () => {
    expect(typeof manifest.id).toBe('string');
    expect(manifest.id).toBe('openclaw-plugin');
  });

  it('has required configSchema field (object)', () => {
    expect(manifest.configSchema).toBeDefined();
    expect(manifest.configSchema.type).toBe('object');
  });

  it('configSchema has routerUrl with localhost:3838 default', () => {
    expect(manifest.configSchema.properties.routerUrl.default).toBe('http://localhost:3838');
  });

  it('declares providers array', () => {
    expect(Array.isArray(manifest.providers)).toBe(true);
    expect(manifest.providers).toContain('robot-resources');
  });
});

describe('OpenClaw SDK contract: package.json', () => {
  let pkg;

  beforeEach(() => {
    const raw = readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf-8');
    pkg = JSON.parse(raw);
  });

  it('has openclaw.extensions field pointing to index.js', () => {
    expect(pkg.openclaw).toBeDefined();
    expect(pkg.openclaw.extensions).toContain('./index.js');
  });

  it('main field matches extensions entry', () => {
    expect(pkg.main).toBe('index.js');
  });
});

describe('OpenClaw SDK contract: plugin shape', () => {
  let plugin;

  beforeEach(async () => {
    const mod = await import('../index.js');
    plugin = mod.default;
  });

  it('default export is an object (not a function)', () => {
    expect(typeof plugin).toBe('object');
    expect(typeof plugin).not.toBe('function');
  });

  it('has required id field', () => {
    expect(typeof plugin.id).toBe('string');
  });

  it('has required name field', () => {
    expect(typeof plugin.name).toBe('string');
  });

  it('has required register function', () => {
    expect(typeof plugin.register).toBe('function');
  });

  it('register calls api.registerProvider with structured object (not positional args)', () => {
    const api = {
      config: {},
      pluginConfig: {},
      logger: { info: vi.fn() },
      registerProvider: vi.fn(),
      on: vi.fn(),
    };

    plugin.register(api);

    expect(api.registerProvider).toHaveBeenCalledOnce();
    const arg = api.registerProvider.mock.calls[0][0];
    // SDK expects a single object argument, NOT (name, config) positional
    expect(typeof arg).toBe('object');
    expect(arg.id).toBe('robot-resources');
    expect(Array.isArray(arg.auth)).toBe(true);
  });

  it('registers before_model_resolve hook for model routing', () => {
    const api = {
      config: {},
      pluginConfig: {},
      logger: { info: vi.fn() },
      registerProvider: vi.fn(),
      on: vi.fn(),
    };

    plugin.register(api);

    const hookNames = api.on.mock.calls.map(c => c[0]);
    expect(hookNames).toContain('before_model_resolve');
  });
});

// ── Provider Registration Tests ────────────────────────────────

describe('register(api) — API key mode', () => {
  let plugin;

  beforeEach(async () => {
    const mod = await import('../index.js');
    plugin = mod.default;
  });

  it('registers robot-resources provider with auth flow', () => {
    const api = {
      config: {},
      pluginConfig: {},
      logger: { info: vi.fn() },
      registerProvider: vi.fn(),
      on: vi.fn(),
    };

    plugin.register(api);

    const provider = api.registerProvider.mock.calls[0][0];
    expect(provider.id).toBe('robot-resources');
    expect(provider.label).toBe('Robot Resources');
    expect(provider.auth).toHaveLength(1);
    expect(provider.auth[0].kind).toBe('custom');
    expect(typeof provider.auth[0].run).toBe('function');
  });

  it('auth run returns configPatch with baseUrl and models', async () => {
    const api = {
      config: {},
      pluginConfig: {},
      logger: { info: vi.fn() },
      registerProvider: vi.fn(),
      on: vi.fn(),
    };

    plugin.register(api);

    const provider = api.registerProvider.mock.calls[0][0];
    const result = await provider.auth[0].run({
      prompter: { text: vi.fn().mockResolvedValue('http://localhost:3838') },
    });

    expect(result.configPatch.models.providers['robot-resources'].baseUrl).toBe('http://localhost:3838');
    expect(result.configPatch.models.providers['robot-resources'].api).toBe('anthropic-messages');
    expect(result.configPatch.models.providers['robot-resources'].models.length).toBeGreaterThan(0);
    expect(result.defaultModel).toContain('robot-resources/');
    expect(result.profiles).toHaveLength(1);
  });

  it('auth run strips trailing slashes from URL', async () => {
    const api = {
      config: {},
      pluginConfig: {},
      logger: { info: vi.fn() },
      registerProvider: vi.fn(),
      on: vi.fn(),
    };

    plugin.register(api);

    const provider = api.registerProvider.mock.calls[0][0];
    const result = await provider.auth[0].run({
      prompter: { text: vi.fn().mockResolvedValue('http://localhost:3838///') },
    });

    expect(result.configPatch.models.providers['robot-resources'].baseUrl).toBe('http://localhost:3838');
  });

  it('uses pluginConfig.routerUrl when provided', () => {
    const api = {
      config: {},
      pluginConfig: { routerUrl: 'http://10.0.0.5:4000' },
      logger: { info: vi.fn() },
      registerProvider: vi.fn(),
      on: vi.fn(),
    };

    plugin.register(api);

    // Provider registered — auth run would use the custom URL
    expect(api.registerProvider).toHaveBeenCalledOnce();
  });
});

// ── Subscription Detection Tests ───────────────────────────────

describe('register(api) — subscription mode', () => {
  let plugin;

  beforeEach(async () => {
    const mod = await import('../index.js');
    plugin = mod.default;
  });

  it('detects subscription via auth.profiles token mode', () => {
    const api = {
      config: { auth: { profiles: { 'anthropic:default': { mode: 'token' } } } },
      pluginConfig: {},
      logger: { info: vi.fn() },
      registerProvider: vi.fn(),
      on: vi.fn(),
    };

    plugin.register(api);

    expect(api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('Subscription mode'),
    );
  });

  it('detects subscription via gateway.auth.mode', () => {
    const api = {
      config: { gateway: { auth: { mode: 'token' } } },
      pluginConfig: {},
      logger: { info: vi.fn() },
      registerProvider: vi.fn(),
      on: vi.fn(),
    };

    plugin.register(api);

    expect(api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('Subscription mode'),
    );
  });

  it('registers before_model_resolve in subscription mode', () => {
    const api = {
      config: { auth: { profiles: { x: { mode: 'token' } } } },
      pluginConfig: {},
      logger: { info: vi.fn() },
      registerProvider: vi.fn(),
      on: vi.fn(),
    };

    plugin.register(api);

    const hooks = api.on.mock.calls.filter(c => c[0] === 'before_model_resolve');
    expect(hooks).toHaveLength(1);
  });

  it('registers before_model_resolve in API-key mode too', () => {
    const api = {
      config: {},
      pluginConfig: {},
      logger: { info: vi.fn() },
      registerProvider: vi.fn(),
      on: vi.fn(),
    };

    plugin.register(api);

    const hooks = api.on.mock.calls.filter(c => c[0] === 'before_model_resolve');
    expect(hooks).toHaveLength(1);
  });

  it('does NOT register provider in subscription mode (prevents hijacking)', () => {
    const api = {
      config: { gateway: { auth: { mode: 'token' } } },
      pluginConfig: {},
      logger: { info: vi.fn() },
      registerProvider: vi.fn(),
      on: vi.fn(),
    };

    plugin.register(api);

    expect(api.registerProvider).not.toHaveBeenCalled();
  });
});

// ── detectSubscriptionMode unit tests ──────────────────────────

describe('detectSubscriptionMode', () => {
  let detectSubscriptionMode;

  beforeEach(async () => {
    const mod = await import('../index.js');
    detectSubscriptionMode = mod.detectSubscriptionMode;
  });

  it('returns true for auth.profiles with token mode', () => {
    expect(detectSubscriptionMode({ auth: { profiles: { x: { mode: 'token' } } } })).toBe(true);
  });

  it('returns true for gateway.auth.mode token', () => {
    expect(detectSubscriptionMode({ gateway: { auth: { mode: 'token' } } })).toBe(true);
  });

  it('returns false for empty config', () => {
    expect(detectSubscriptionMode({})).toBe(false);
  });

  it('returns false for null/undefined', () => {
    expect(detectSubscriptionMode(null)).toBe(false);
    expect(detectSubscriptionMode(undefined)).toBe(false);
  });

  it('returns false for apikey mode profiles', () => {
    expect(detectSubscriptionMode({ auth: { profiles: { x: { mode: 'apikey' } } } })).toBe(false);
  });
});

// ── before_tool_call hook Tests ─────────────────────────────────

describe('before_tool_call hook', () => {
  let plugin;
  let beforeToolCallHandler;

  beforeEach(async () => {
    const mod = await import('../index.js');
    plugin = mod.default;

    const api = {
      config: {},
      pluginConfig: {},
      logger: { info: vi.fn() },
      registerProvider: vi.fn(),
      on: vi.fn(),
    };

    plugin.register(api);

    const hookCall = api.on.mock.calls.find(c => c[0] === 'before_tool_call');
    beforeToolCallHandler = hookCall[1];
  });

  it('redirects web_fetch to scraper_compress_url with correct params', async () => {
    const event = { tool: 'web_fetch', params: { url: 'https://example.com' } };

    const result = await beforeToolCallHandler(event, {});

    expect(result).toEqual({
      toolOverride: 'scraper_compress_url',
      paramsOverride: { url: 'https://example.com', mode: 'auto' },
    });
  });

  it('returns undefined for non-web_fetch tools (passthrough)', async () => {
    const event = { tool: 'bash', params: { command: 'ls' } };

    const result = await beforeToolCallHandler(event, {});

    expect(result).toBeUndefined();
  });

  it('returns undefined when URL is missing from params', async () => {
    const event = { tool: 'web_fetch', params: {} };

    const result = await beforeToolCallHandler(event, {});

    expect(result).toBeUndefined();
  });

  it('returns undefined when params is undefined', async () => {
    const event = { tool: 'web_fetch' };

    const result = await beforeToolCallHandler(event, {});

    expect(result).toBeUndefined();
  });

  it('passes URL and mode:"auto" in paramsOverride', async () => {
    const testUrl = 'https://docs.example.com/api/v2/reference';
    const event = { tool: 'web_fetch', params: { url: testUrl } };

    const result = await beforeToolCallHandler(event, {});

    expect(result.paramsOverride.url).toBe(testUrl);
    expect(result.paramsOverride.mode).toBe('auto');
  });

  it('registers the hook with priority 10', async () => {
    const api = {
      config: {},
      pluginConfig: {},
      logger: { info: vi.fn() },
      registerProvider: vi.fn(),
      on: vi.fn(),
    };

    plugin.register(api);

    const hookCall = api.on.mock.calls.find(c => c[0] === 'before_tool_call');
    expect(hookCall[2]).toEqual({ priority: 10 });
  });
});

// ── Exports Tests ───────────────────────────────────────────────

describe('exports', () => {
  it('exports DEFAULT_ROUTER_URL', async () => {
    const mod = await import('../index.js');
    expect(mod.DEFAULT_ROUTER_URL).toBe('http://localhost:3838');
  });

  it('exports ROUTER_MODELS as non-empty array', async () => {
    const mod = await import('../index.js');
    expect(Array.isArray(mod.ROUTER_MODELS)).toBe(true);
    expect(mod.ROUTER_MODELS.length).toBeGreaterThan(0);
  });

  it('exports askRouter function', async () => {
    const mod = await import('../index.js');
    expect(typeof mod.askRouter).toBe('function');
  });

  it('exports detectSubscriptionMode function', async () => {
    const mod = await import('../index.js');
    expect(typeof mod.detectSubscriptionMode).toBe('function');
  });

  it('default export is plugin object with id', async () => {
    const mod = await import('../index.js');
    expect(mod.default.id).toBe('openclaw-plugin');
  });
});

// ── check_installation_status tool Tests ──────────────────────────

describe('check_installation_status tool', () => {
  let plugin;

  beforeEach(async () => {
    const mod = await import('../index.js');
    plugin = mod.default;
  });

  it('registers tool when api.registerTool is available', () => {
    const api = {
      config: {},
      pluginConfig: {},
      logger: { info: vi.fn() },
      registerProvider: vi.fn(),
      registerTool: vi.fn(),
      on: vi.fn(),
    };

    plugin.register(api);

    expect(api.registerTool).toHaveBeenCalledOnce();
    const tool = api.registerTool.mock.calls[0][0];
    expect(tool.name).toBe('check_installation_status');
    expect(typeof tool.execute).toBe('function');
    expect(typeof tool.description).toBe('string');
  });

  it('does not crash when api.registerTool is not available', () => {
    const api = {
      config: {},
      pluginConfig: {},
      logger: { info: vi.fn() },
      registerProvider: vi.fn(),
      on: vi.fn(),
    };

    // Should not throw
    expect(() => plugin.register(api)).not.toThrow();
  });

  it('tool handler returns structured report', async () => {
    const api = {
      config: {},
      pluginConfig: {},
      logger: { info: vi.fn() },
      registerProvider: vi.fn(),
      registerTool: vi.fn(),
      on: vi.fn(),
    };

    plugin.register(api);

    const tool = api.registerTool.mock.calls[0][0];
    const result = await tool.execute();

    expect(result).toHaveProperty('status');
    expect(result).toHaveProperty('components');
    expect(result).toHaveProperty('summary');
    expect(result).toHaveProperty('next_steps');
    expect(result.components).toHaveProperty('router');
    expect(result.components).toHaveProperty('scraper');
    expect(result.components).toHaveProperty('platform');
    expect(result.components).toHaveProperty('mcp');
  });

  it('tool handler returns next_steps on failure', async () => {
    const api = {
      config: {},
      pluginConfig: {},
      logger: { info: vi.fn() },
      registerProvider: vi.fn(),
      registerTool: vi.fn(),
      on: vi.fn(),
    };

    plugin.register(api);

    const tool = api.registerTool.mock.calls[0][0];
    const result = await tool.execute();

    // In test env no services running, so expect failures with next_steps
    expect(Array.isArray(result.next_steps)).toBe(true);
    if (result.status !== 'healthy') {
      expect(result.next_steps.length).toBeGreaterThan(0);
    }
  });
});

// ── Observability Hooks (TKT-260) ─────────────────────────────

describe('after_tool_call hook', () => {
  let plugin;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../index.js');
    plugin = mod.default;
  });

  it('registers after_tool_call hook', () => {
    const api = {
      config: {},
      pluginConfig: {},
      logger: { info: vi.fn() },
      registerProvider: vi.fn(),
      on: vi.fn(),
    };

    plugin.register(api);

    const hookNames = api.on.mock.calls.map(c => c[0]);
    expect(hookNames).toContain('after_tool_call');
  });

  it('handler does not crash on well-formed event', async () => {
    const api = {
      config: {},
      pluginConfig: {},
      logger: { info: vi.fn() },
      registerProvider: vi.fn(),
      on: vi.fn(),
    };

    plugin.register(api);

    const hookCall = api.on.mock.calls.find(c => c[0] === 'after_tool_call');
    const handler = hookCall[1];

    // Should not throw
    await expect(handler({ tool: 'exec', params: { command: 'ls' }, result: 'file1\nfile2' }, {})).resolves.not.toThrow();
  });

  it('handler does not crash on empty/undefined event fields', async () => {
    const api = {
      config: {},
      pluginConfig: {},
      logger: { info: vi.fn() },
      registerProvider: vi.fn(),
      on: vi.fn(),
    };

    plugin.register(api);

    const hookCall = api.on.mock.calls.find(c => c[0] === 'after_tool_call');
    const handler = hookCall[1];

    await expect(handler({}, {})).resolves.not.toThrow();
    await expect(handler({ tool: 'exec' }, {})).resolves.not.toThrow();
    await expect(handler(undefined, {})).resolves.not.toThrow();
  });

  it('returns undefined (does not modify tool result)', async () => {
    const api = {
      config: {},
      pluginConfig: {},
      logger: { info: vi.fn() },
      registerProvider: vi.fn(),
      on: vi.fn(),
    };

    plugin.register(api);

    const hookCall = api.on.mock.calls.find(c => c[0] === 'after_tool_call');
    const handler = hookCall[1];

    const result = await handler({ tool: 'exec', params: {}, result: 'ok' }, {});
    expect(result).toBeUndefined();
  });
});

describe('llm_output hook', () => {
  let plugin;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../index.js');
    plugin = mod.default;
  });

  it('registers llm_output hook', () => {
    const api = {
      config: {},
      pluginConfig: {},
      logger: { info: vi.fn() },
      registerProvider: vi.fn(),
      on: vi.fn(),
    };

    plugin.register(api);

    const hookNames = api.on.mock.calls.map(c => c[0]);
    expect(hookNames).toContain('llm_output');
  });

  it('handler does not crash on well-formed event', async () => {
    const api = {
      config: {},
      pluginConfig: {},
      logger: { info: vi.fn() },
      registerProvider: vi.fn(),
      on: vi.fn(),
    };

    plugin.register(api);

    const hookCall = api.on.mock.calls.find(c => c[0] === 'llm_output');
    const handler = hookCall[1];

    await expect(handler({
      response: {
        content: 'Hello',
        tool_calls: [{ name: 'exec', input: { command: 'ls' } }],
      },
    }, {})).resolves.not.toThrow();
  });

  it('handler does not crash on empty/undefined event', async () => {
    const api = {
      config: {},
      pluginConfig: {},
      logger: { info: vi.fn() },
      registerProvider: vi.fn(),
      on: vi.fn(),
    };

    plugin.register(api);

    const hookCall = api.on.mock.calls.find(c => c[0] === 'llm_output');
    const handler = hookCall[1];

    await expect(handler({}, {})).resolves.not.toThrow();
    await expect(handler(undefined, {})).resolves.not.toThrow();
  });

  it('returns undefined (observation only, does not modify LLM output)', async () => {
    const api = {
      config: {},
      pluginConfig: {},
      logger: { info: vi.fn() },
      registerProvider: vi.fn(),
      on: vi.fn(),
    };

    plugin.register(api);

    const hookCall = api.on.mock.calls.find(c => c[0] === 'llm_output');
    const handler = hookCall[1];

    const result = await handler({ response: { content: 'test' } }, {});
    expect(result).toBeUndefined();
  });
});

describe('observability hooks debug logging', () => {
  let appendFileSyncMock;

  beforeEach(async () => {
    vi.resetModules();
    process.env.RR_DEBUG = '1';
  });

  afterEach(() => {
    delete process.env.RR_DEBUG;
  });

  it('after_tool_call writes to plugin-decisions.jsonl when RR_DEBUG=1', async () => {
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual('node:fs');
      appendFileSyncMock = vi.fn();
      return {
        ...actual,
        appendFileSync: appendFileSyncMock,
      };
    });

    const mod = await import('../index.js');
    const plugin = mod.default;

    const handlers = {};
    const api = {
      config: {},
      pluginConfig: {},
      logger: { info: vi.fn() },
      registerProvider: vi.fn(),
      on: vi.fn((event, handler) => {
        if (!handlers[event]) handlers[event] = [];
        handlers[event].push(handler);
      }),
    };

    plugin.register(api);

    const afterToolHandlers = handlers['after_tool_call'];
    expect(afterToolHandlers).toBeDefined();
    await afterToolHandlers[0]({ tool: 'exec', params: { command: 'npm test' }, result: 'PASS' }, {});

    expect(appendFileSyncMock).toHaveBeenCalled();
    const written = appendFileSyncMock.mock.calls.find(c =>
      typeof c[1] === 'string' && c[1].includes('after_tool_call'),
    );
    expect(written).toBeDefined();
    const entry = JSON.parse(written[1].trim());
    expect(entry.hook).toBe('after_tool_call');
    expect(entry.tool).toBe('exec');
    expect(entry.timestamp).toBeDefined();
  });

  it('llm_output writes tool_calls info when present', async () => {
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual('node:fs');
      appendFileSyncMock = vi.fn();
      return {
        ...actual,
        appendFileSync: appendFileSyncMock,
      };
    });

    const mod = await import('../index.js');
    const plugin = mod.default;

    const handlers = {};
    const api = {
      config: {},
      pluginConfig: {},
      logger: { info: vi.fn() },
      registerProvider: vi.fn(),
      on: vi.fn((event, handler) => {
        if (!handlers[event]) handlers[event] = [];
        handlers[event].push(handler);
      }),
    };

    plugin.register(api);

    const llmHandlers = handlers['llm_output'];
    expect(llmHandlers).toBeDefined();
    await llmHandlers[0]({
      response: {
        tool_calls: [
          { name: 'exec', input: {} },
          { name: 'scraper_compress_url', input: {} },
        ],
      },
    }, {});

    expect(appendFileSyncMock).toHaveBeenCalled();
    const written = appendFileSyncMock.mock.calls.find(c =>
      typeof c[1] === 'string' && c[1].includes('llm_output'),
    );
    expect(written).toBeDefined();
    const entry = JSON.parse(written[1].trim());
    expect(entry.hook).toBe('llm_output');
    expect(entry.tool_calls).toEqual(['exec', 'scraper_compress_url']);
  });

  it('after_tool_call truncates large results to 500 chars', async () => {
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual('node:fs');
      appendFileSyncMock = vi.fn();
      return {
        ...actual,
        appendFileSync: appendFileSyncMock,
      };
    });

    const mod = await import('../index.js');
    const plugin = mod.default;

    const handlers = {};
    const api = {
      config: {},
      pluginConfig: {},
      logger: { info: vi.fn() },
      registerProvider: vi.fn(),
      on: vi.fn((event, handler) => {
        if (!handlers[event]) handlers[event] = [];
        handlers[event].push(handler);
      }),
    };

    plugin.register(api);

    const bigResult = 'x'.repeat(2000);
    await handlers['after_tool_call'][0]({ tool: 'exec', result: bigResult }, {});

    const written = appendFileSyncMock.mock.calls.find(c =>
      typeof c[1] === 'string' && c[1].includes('after_tool_call'),
    );
    const entry = JSON.parse(written[1].trim());
    expect(entry.result.length).toBeLessThanOrEqual(503); // 500 + "..."
  });
});

describe('post-install message injection', () => {
  let plugin;

  beforeEach(async () => {
    vi.resetModules();
  });

  it('injects install summary when wizard-status.json is fresh', async () => {
    const freshStatus = {
      completed_at: new Date().toISOString(),
      health_report: {
        status: 'healthy',
        components: {
          router: { healthy: true, detail: 'running' },
          scraper: { healthy: true, detail: 'MCP registered' },
          platform: { healthy: true, detail: 'reachable' },
          mcp: { healthy: true, detail: 'plugin registered' },
        },
        summary: 'All 4 components healthy.',
      },
      claim_url: 'https://robotresources.ai/claim?token=test',
    };

    // Mock fs to return fresh wizard-status.json and no ack file
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual('node:fs');
      return {
        ...actual,
        writeFileSync: vi.fn(),
        readFileSync: (path, ...args) => {
          if (typeof path === 'string' && path.includes('wizard-status.json')) {
            return JSON.stringify(freshStatus);
          }
          if (typeof path === 'string' && path.includes('.install-ack')) {
            throw new Error('ENOENT');
          }
          return actual.readFileSync(path, ...args);
        },
      };
    });

    const mod = await import('../index.js');
    plugin = mod.default;

    const handlers = {};
    const api = {
      config: {},
      pluginConfig: {},
      logger: { info: vi.fn() },
      registerProvider: vi.fn(),
      registerTool: vi.fn(),
      on: vi.fn((event, handler) => { handlers[event] = handler; }),
    };

    plugin.register(api);

    // Trigger message_sending
    const result = handlers.message_sending({ content: 'Hello!' }, {});
    expect(result).toBeDefined();
    expect(result.content).toContain('Robot Resources installed successfully');
    expect(result.content).toContain('[RR:OK]');
    expect(result.content).toContain('Router');
    expect(result.content).toContain('Scraper');
    expect(result.content).toContain('cost savings');
    expect(result.content).toContain('token reduction');
    expect(result.content).toContain('new conversation');
    expect(result.content).toContain('Dashboard:');

    // Second call should NOT inject again
    const result2 = handlers.message_sending({ content: 'Follow up' }, {});
    expect(result2).toBeUndefined();
  });

  it('does not inject when install was already acknowledged', async () => {
    const status = {
      completed_at: '2026-04-01T00:00:00.000Z',
      health_report: { status: 'healthy', components: {} },
    };

    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual('node:fs');
      return {
        ...actual,
        writeFileSync: vi.fn(),
        readFileSync: (path, ...args) => {
          if (typeof path === 'string' && path.includes('wizard-status.json')) {
            return JSON.stringify(status);
          }
          if (typeof path === 'string' && path.includes('.install-ack')) {
            return status.completed_at; // ack matches → already shown
          }
          return actual.readFileSync(path, ...args);
        },
      };
    });

    const mod = await import('../index.js');
    plugin = mod.default;

    const handlers = {};
    const api = {
      config: {},
      pluginConfig: {},
      logger: { info: vi.fn() },
      registerProvider: vi.fn(),
      registerTool: vi.fn(),
      on: vi.fn((event, handler) => { handlers[event] = handler; }),
    };

    plugin.register(api);

    // message_sending should not inject (no routing either)
    const result = handlers.message_sending({ content: 'Hello!' }, {});
    expect(result).toBeUndefined();
  });

  it('does not crash when wizard-status.json is missing', async () => {
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual('node:fs');
      return {
        ...actual,
        readFileSync: (path, ...args) => {
          if (typeof path === 'string' && path.includes('wizard-status.json')) {
            throw new Error('ENOENT');
          }
          return actual.readFileSync(path, ...args);
        },
      };
    });

    const mod = await import('../index.js');
    plugin = mod.default;

    const api = {
      config: {},
      pluginConfig: {},
      logger: { info: vi.fn() },
      registerProvider: vi.fn(),
      registerTool: vi.fn(),
      on: vi.fn(),
    };

    // Should not throw
    expect(() => plugin.register(api)).not.toThrow();
  });
});
