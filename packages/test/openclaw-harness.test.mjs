/**
 * OpenClaw Harness Tests — extracted from real OpenClaw source.
 *
 * These tests simulate how OpenClaw's plugin loader actually loads
 * and registers our plugin. Based on:
 * - github.com/openclaw/openclaw/blob/main/src/plugins/loader.ts
 * - github.com/openclaw/openclaw/blob/main/src/plugins/registry.ts
 *
 * This catches issues like:
 * - Plugin export shape wrong (object vs function)
 * - Calling APIs that don't exist (e.g. before_model_resolve)
 * - Provider registration with wrong signature
 * - Missing required fields in manifest
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..');

// Top-level import of our plugin module
const pluginModule = await import('../lib/plugin-core.js');
const plugin = pluginModule.default;

// ── OpenClaw Plugin Loader Simulation ──────────────────────────
// Extracted from openclaw/src/plugins/loader.ts: resolvePluginModuleExport()

function resolvePluginModuleExport(moduleExport) {
  const resolved =
    moduleExport &&
    typeof moduleExport === 'object' &&
    'default' in moduleExport
      ? moduleExport.default
      : moduleExport;

  if (typeof resolved === 'function') {
    return { register: resolved };
  }
  if (resolved && typeof resolved === 'object') {
    const def = resolved;
    const register = def.register ?? def.activate;
    return { definition: def, register };
  }
  return {};
}

// ── OpenClaw API Shape Simulation ──────────────────────────────
// Extracted from openclaw/src/plugins/registry.ts: createApi()

// Valid hook names from OpenClaw's src/plugins/types.ts: PluginHookName
const VALID_HOOK_NAMES = new Set([
  'before_model_resolve',
  'before_prompt_build',
  'before_agent_start',
  'llm_input',
  'llm_output',
  'agent_end',
  'before_compaction',
  'after_compaction',
  'before_reset',
  'inbound_claim',
  'message_received',
  'message_sending',
  'message_sent',
  'before_tool_call',
  'after_tool_call',
  'tool_result_persist',
  'before_message_write',
  'session_start',
  'session_end',
  'subagent_spawning',
  'subagent_delivery_target',
  'subagent_spawned',
  'subagent_ended',
  'gateway_start',
  'gateway_stop',
]);

function createMockOpenClawApi(config = {}, pluginConfig = {}) {
  const registrations = {
    providers: [],
    typedHooks: [],
    diagnostics: [],
  };

  const api = {
    id: 'openclaw-plugin',
    name: 'Robot Resources Router',
    version: '0.2.0',
    source: join(PLUGIN_ROOT, 'index.js'),
    rootDir: PLUGIN_ROOT,
    registrationMode: 'full',
    config,
    pluginConfig,
    runtime: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    registerProvider: vi.fn((provider) => {
      if (!provider || typeof provider !== 'object') {
        registrations.diagnostics.push('registerProvider: non-object arg');
        return;
      }
      if (!provider.id) {
        registrations.diagnostics.push('registerProvider: missing id');
        return;
      }
      registrations.providers.push(provider);
    }),
    registerTool: vi.fn(),
    registerHook: vi.fn(),
    registerChannel: vi.fn(),
    registerSpeechProvider: vi.fn(),
    registerMediaUnderstandingProvider: vi.fn(),
    registerImageGenerationProvider: vi.fn(),
    registerWebSearchProvider: vi.fn(),
    registerGatewayMethod: vi.fn(),
    registerCli: vi.fn(),
    registerService: vi.fn(),
    registerInteractiveHandler: vi.fn(),
    registerCommand: vi.fn(),
    registerContextEngine: vi.fn(),
    registerMemoryPromptSection: vi.fn(),
    registerHttpRoute: vi.fn(),
    onConversationBindingResolved: vi.fn(),
    resolvePath: vi.fn((input) => input),
    on: vi.fn((hookName, handler, opts) => {
      if (!VALID_HOOK_NAMES.has(hookName)) {
        registrations.diagnostics.push(`unknown typed hook "${hookName}" ignored`);
        return;
      }
      registrations.typedHooks.push({ hookName, handler, priority: opts?.priority });
    }),
  };

  return { api, registrations };
}

// ── Tests ──────────────────────────────────────────────────────

describe('OpenClaw harness: plugin loading', () => {
  it('resolves plugin export the same way OpenClaw does', () => {
    const resolved = resolvePluginModuleExport(pluginModule);

    expect(resolved.definition).toBeDefined();
    expect(typeof resolved.register).toBe('function');
    expect(resolved.definition.id).toBe('openclaw-plugin');
  });

  it('plugin id matches manifest id (OpenClaw rejects mismatches)', () => {
    const manifest = JSON.parse(
      readFileSync(join(PLUGIN_ROOT, 'openclaw.plugin.json'), 'utf-8'),
    );
    const resolved = resolvePluginModuleExport(pluginModule);

    expect(resolved.definition.id).toBe(manifest.id);
  });

  it('register is not async (OpenClaw warns and ignores async results)', () => {
    const { api } = createMockOpenClawApi();
    const resolved = resolvePluginModuleExport(pluginModule);

    const result = resolved.register(api);

    expect(result?.then).toBeUndefined();
  });
});

describe('OpenClaw harness: provider registration', () => {
  it('registers provider with object signature (not positional args)', () => {
    const { api, registrations } = createMockOpenClawApi();

    plugin.register(api);

    expect(api.registerProvider).toHaveBeenCalledOnce();
    const arg = api.registerProvider.mock.calls[0][0];
    expect(typeof arg).toBe('object');
    expect(typeof arg).not.toBe('string');
    expect(arg.id).toBe('robot-resources');
    expect(Array.isArray(arg.auth)).toBe(true);
    expect(arg.auth.length).toBeGreaterThan(0);
  });

  it('provider auth has required fields per OpenClaw SDK', () => {
    const { api } = createMockOpenClawApi();
    plugin.register(api);

    const provider = api.registerProvider.mock.calls[0][0];
    const auth = provider.auth[0];

    expect(auth.id).toBeDefined();
    expect(auth.kind).toBe('custom');
    expect(typeof auth.run).toBe('function');
  });

  it('provider auth run returns valid configPatch structure', async () => {
    const { api } = createMockOpenClawApi();
    plugin.register(api);

    const provider = api.registerProvider.mock.calls[0][0];
    const result = await provider.auth[0].run({
      prompter: { text: vi.fn().mockResolvedValue('http://localhost:3838') },
    });

    expect(result.configPatch).toBeDefined();
    expect(result.configPatch.models.providers['robot-resources']).toBeDefined();

    const pConfig = result.configPatch.models.providers['robot-resources'];
    expect(pConfig.baseUrl).toBe('http://localhost:3838');
    expect(pConfig.api).toBe('anthropic-messages');
    expect(Array.isArray(pConfig.models)).toBe(true);
    expect(pConfig.models.length).toBeGreaterThan(0);
    expect(pConfig.models[0].id).toBeDefined();
    expect(pConfig.models[0].api).toBe('anthropic-messages');

    expect(Array.isArray(result.profiles)).toBe(true);
    expect(result.defaultModel).toContain('robot-resources/');
  });

  it('no diagnostics (no invalid API calls)', () => {
    const { api, registrations } = createMockOpenClawApi();
    plugin.register(api);

    expect(registrations.diagnostics).toEqual([]);
  });
});

describe('OpenClaw harness: before_model_resolve hook', () => {
  it('registers before_model_resolve hook (valid OpenClaw hook)', () => {
    const { api, registrations } = createMockOpenClawApi();

    plugin.register(api);

    const modelHooks = registrations.typedHooks.filter(
      (h) => h.hookName === 'before_model_resolve',
    );
    expect(modelHooks).toHaveLength(1);
  });

  it('registers before_model_resolve in subscription mode too', () => {
    const { api, registrations } = createMockOpenClawApi({
      auth: { profiles: { 'anthropic:default': { mode: 'token' } } },
    });

    plugin.register(api);

    const modelHooks = registrations.typedHooks.filter(
      (h) => h.hookName === 'before_model_resolve',
    );
    expect(modelHooks).toHaveLength(1);
  });

  it('does NOT use any invalid hooks', () => {
    const { api, registrations } = createMockOpenClawApi();

    plugin.register(api);

    const invalidHooks = registrations.diagnostics.filter((d) =>
      d.includes('unknown typed hook'),
    );
    expect(invalidHooks).toHaveLength(0);
  });

  it('no diagnostics in any mode', () => {
    const { api, registrations } = createMockOpenClawApi({
      auth: { profiles: { 'anthropic:default': { mode: 'token' } } },
    });

    plugin.register(api);

    expect(registrations.diagnostics).toEqual([]);
  });
});

describe('OpenClaw harness: package.json compliance', () => {
  it('has openclaw.extensions field (required for discovery)', () => {
    const pkg = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf-8'));

    expect(pkg.openclaw).toBeDefined();
    expect(Array.isArray(pkg.openclaw.extensions)).toBe(true);
    expect(pkg.openclaw.extensions.length).toBeGreaterThan(0);
  });

  it('extensions entries start with ./ (relative path)', () => {
    const pkg = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf-8'));

    for (const ext of pkg.openclaw.extensions) {
      expect(ext.startsWith('./')).toBe(true);
    }
  });
});
