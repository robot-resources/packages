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
    expect(manifest.id).toBe('robot-resources-router');
  });

  it('has required configSchema field (object)', () => {
    expect(manifest.configSchema).toBeDefined();
    expect(manifest.configSchema.type).toBe('object');
  });

  it('configSchema is empty (Option 4: no separate router process to configure)', () => {
    expect(manifest.configSchema.properties).toEqual({});
  });

  it('declares the robot-resources provider in the manifest', () => {
    expect(manifest.providers).toEqual(['robot-resources']);
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
    vi.resetModules();
    const mod = await import('../lib/plugin-core.js');
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

  it('register calls api.registerProvider once with id "robot-resources"', () => {
    const api = {
      config: {},
      pluginConfig: {},
      logger: { info: vi.fn(), warn: vi.fn() },
      registerProvider: vi.fn(),
      on: vi.fn(),
    };

    plugin.register(api);

    expect(api.registerProvider).toHaveBeenCalledTimes(1);
    const arg = api.registerProvider.mock.calls[0][0];
    expect(arg.id).toBe('robot-resources');
    expect(typeof arg.catalog?.run).toBe('function');
    expect(typeof arg.staticCatalog?.run).toBe('function');
    expect(Array.isArray(arg.auth)).toBe(true);
  });
});

// ── Subscription Detection Tests ───────────────────────────────

describe('register(api) — subscription mode', () => {
  let plugin;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../lib/plugin-core.js');
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

  it('registers the robot-resources provider in subscription mode', () => {
    const api = {
      config: { auth: { profiles: { x: { mode: 'token' } } } },
      pluginConfig: {},
      logger: { info: vi.fn(), warn: vi.fn() },
      registerProvider: vi.fn(),
      on: vi.fn(),
    };

    plugin.register(api);

    expect(api.registerProvider).toHaveBeenCalledTimes(1);
    expect(api.registerProvider.mock.calls[0][0].id).toBe('robot-resources');
  });

  it('registers the robot-resources provider in API-key mode too', () => {
    const api = {
      config: {},
      pluginConfig: {},
      logger: { info: vi.fn(), warn: vi.fn() },
      registerProvider: vi.fn(),
      on: vi.fn(),
    };

    plugin.register(api);

    expect(api.registerProvider).toHaveBeenCalledTimes(1);
    expect(api.registerProvider.mock.calls[0][0].id).toBe('robot-resources');
  });
});

// ── plugin_register dedup ──────────────────────────────────────
//
// OpenClaw calls register() multiple times per session (once per internal
// subsystem). Before this dedup, each call produced a separate
// `plugin_register` telemetry event — inflating "distinct install" counts
// by 3-4x in production. Test asserts fetch is only hit ONCE per process,
// regardless of how many times register() is invoked.

describe('plugin_register dedup', () => {
  let plugin;
  let emitSpy;

  beforeEach(async () => {
    // Reset the module cache so the module-level _registerEmitted guard
    // in plugin-core.js starts false for each test. Without this, tests
    // share the same module instance and dedup state persists.
    vi.resetModules();

    // Mock the telemetry client so we can count plugin_register emits
    // directly — avoids needing a real api_key on disk or a fake server.
    emitSpy = vi.fn();
    vi.doMock('../lib/telemetry.js', () => ({
      createTelemetry: () => ({ emit: emitSpy, PLUGIN_VERSION: 'test' }),
    }));
    // runUpdateCheck + runBufferFlush are fire-and-forget; stub them so
    // they don't touch the network during tests.
    vi.doMock('../lib/update-check.js', () => ({ runUpdateCheck: vi.fn() }));
    vi.doMock('../lib/buffer-flush.js', () => ({ runBufferFlush: vi.fn() }));
    // Stub the local HTTP server so tests don't actually bind a port.
    vi.doMock('../lib/local-server.js', () => ({
      startLocalServer: vi.fn(async () => ({ port: 0, server: { close: vi.fn() } })),
    }));

    const mod = await import('../lib/plugin-core.js');
    plugin = mod.default;
  });

  afterEach(() => {
    vi.doUnmock('../lib/telemetry.js');
    vi.doUnmock('../lib/update-check.js');
    vi.doUnmock('../lib/buffer-flush.js');
    vi.doUnmock('../lib/local-server.js');
    vi.restoreAllMocks();
  });

  function makeApi() {
    return {
      config: {},
      pluginConfig: {},
      logger: { info: vi.fn(), warn: vi.fn() },
      registerProvider: vi.fn(),
      on: vi.fn(),
    };
  }

  function pluginRegisterCount() {
    return emitSpy.mock.calls.filter((c) => c[0] === 'plugin_register').length;
  }

  it('emits plugin_register at most once across multiple register() calls', () => {
    plugin.register(makeApi());
    plugin.register(makeApi());
    plugin.register(makeApi());
    plugin.register(makeApi());

    expect(pluginRegisterCount()).toBe(1);
  });

  it('still emits plugin_register on the very first register() call', () => {
    plugin.register(makeApi());
    expect(pluginRegisterCount()).toBe(1);
  });

  it('plugin_register payload includes mode: "in-process" (PR 2)', () => {
    plugin.register(makeApi());
    const event = emitSpy.mock.calls.find((c) => c[0] === 'plugin_register');
    expect(event).toBeDefined();
    expect(event[1].mode).toBe('in-process');
  });
});

// ── register() work-level idempotency ──────────────────────────
//
// The telemetry dedup above protects adoption metrics; this block protects
// the rest of register() — hook registration, tool registration, provider
// registration, fresh-install ack. The first register() call does the
// setup; subsequent calls in the same process skip the work block and
// return early. Multiple api instances won't see duplicate hook wiring.

describe('register() work-level idempotency', () => {
  let plugin;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('../lib/update-check.js', () => ({ runUpdateCheck: vi.fn() }));
    vi.doMock('../lib/buffer-flush.js', () => ({ runBufferFlush: vi.fn() }));

    const mod = await import('../lib/plugin-core.js');
    plugin = mod.default;
  });

  afterEach(() => {
    vi.doUnmock('../lib/update-check.js');
    vi.doUnmock('../lib/buffer-flush.js');
    vi.restoreAllMocks();
  });

  function makeApi() {
    return {
      config: {},
      pluginConfig: {},
      logger: { info: vi.fn(), warn: vi.fn() },
      registerProvider: vi.fn(),
      registerTool: vi.fn(),
      on: vi.fn(),
    };
  }

  it('registers hooks exactly once across multiple register() calls', () => {
    const api1 = makeApi();
    const api2 = makeApi();

    plugin.register(api1);
    plugin.register(api2);

    // First call wires every hook, second call is a no-op.
    expect(api1.on.mock.calls.length).toBeGreaterThan(0);
    expect(api2.on).not.toHaveBeenCalled();
  });

  it('registers the installation-status tool exactly once', () => {
    const api1 = makeApi();
    const api2 = makeApi();

    plugin.register(api1);
    plugin.register(api2);

    expect(api1.registerTool).toHaveBeenCalledOnce();
    expect(api2.registerTool).not.toHaveBeenCalled();
  });
});

// ── detectSubscriptionMode unit tests ──────────────────────────

describe('detectSubscriptionMode', () => {
  let detectSubscriptionMode;

  beforeEach(async () => {
    const mod = await import('../lib/plugin-core.js');
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

// ── Exports Tests ───────────────────────────────────────────────
//
// Named exports live on ./lib/plugin-core.js — the shim at index.js uses
// deferred loading (jiti does not support top-level await) so it cannot
// re-export them synchronously. External callers should import from
// './lib/plugin-core.js' directly.

describe('exports', () => {
  it('exports askRouter function from plugin-core', async () => {
    const mod = await import('../lib/plugin-core.js');
    expect(typeof mod.askRouter).toBe('function');
  });

  it('exports detectSubscriptionMode function from plugin-core', async () => {
    const mod = await import('../lib/plugin-core.js');
    expect(typeof mod.detectSubscriptionMode).toBe('function');
  });

  it('default export on index.js is plugin shim with id', async () => {
    const mod = await import('../lib/plugin-core.js');
    expect(mod.default.id).toBe('robot-resources-router');
  });
});

// ── check_installation_status tool Tests ──────────────────────────

describe('check_installation_status tool', () => {
  let plugin;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../lib/plugin-core.js');
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
    const mod = await import('../lib/plugin-core.js');
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
    const mod = await import('../lib/plugin-core.js');
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

    const mod = await import('../lib/plugin-core.js');
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

    const mod = await import('../lib/plugin-core.js');
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

    const mod = await import('../lib/plugin-core.js');
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

    const mod = await import('../lib/plugin-core.js');
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

    const mod = await import('../lib/plugin-core.js');
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

    const mod = await import('../lib/plugin-core.js');
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

// ── Recurring Heartbeat ──────────────────────────────────────────
// Once-only plugin_register has no retry; a transient failure at OC boot
// strands the install (silent fleet). Recurring router_heartbeat at 15min
// guarantees a recovery window — verified on live droplet 2026-05-01.

describe('register(api) — recurring heartbeat', () => {
  let plugin;
  let setIntervalSpy;

  beforeEach(async () => {
    vi.resetModules();
    setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const mod = await import('../lib/plugin-core.js');
    plugin = mod.default;
  });

  afterEach(() => {
    setIntervalSpy.mockRestore();
  });

  it('schedules a recurring heartbeat on first register()', () => {
    const api = {
      config: {},
      pluginConfig: {},
      logger: { info: vi.fn() },
      registerProvider: vi.fn(),
      on: vi.fn(),
    };

    plugin.register(api);

    const heartbeatCalls = setIntervalSpy.mock.calls.filter(
      ([, ms]) => ms === 15 * 60 * 1_000,
    );
    expect(heartbeatCalls).toHaveLength(1);
  });

  it('schedules the heartbeat exactly once across multiple register() calls', () => {
    const api = {
      config: {},
      pluginConfig: {},
      logger: { info: vi.fn() },
      registerProvider: vi.fn(),
      on: vi.fn(),
    };

    plugin.register(api);
    plugin.register(api);
    plugin.register(api);

    const heartbeatCalls = setIntervalSpy.mock.calls.filter(
      ([, ms]) => ms === 15 * 60 * 1_000,
    );
    expect(heartbeatCalls).toHaveLength(1);
  });
});
