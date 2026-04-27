/**
 * Robot Resources plugin for OpenClaw — core implementation.
 *
 * Routes per-prompt via an in-process HTTP server (lib/local-server.js)
 * registered as the `robot-resources` provider in OC's catalog. The server
 * runs the JS classifier on each user prompt, picks the best Anthropic
 * model, and forwards to api.anthropic.com with the user's existing
 * Anthropic key. No daemon, no localhost:3838, no Python.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createTelemetry } from './telemetry.js';
import { runUpdateCheck } from './update-check.js';
import { runBufferFlush } from './buffer-flush.js';
import { asyncRoutePrompt } from './routing/router.js';
import { MODELS_DB } from './routing/selector.js';
import { classifyWithLlmDetailed } from './routing/classify.js';
import { startLocalServer } from './local-server.js';

const DEBUG = !!process.env.RR_DEBUG;
let _debugPath = null;

// Guard so plugin_register fires at most once per Node process lifetime.
// OpenClaw calls register() multiple times per session — once per internal
// subsystem (model resolve, tool dispatch, hook registration, etc.) —
// producing 3-4 telemetry events for a single plugin load. That inflates
// every "distinct install" metric by the same factor. Emitting once per
// process gives us accurate adoption numbers without losing the signal.
let _registerEmitted = false;

// Second guard for the per-process setup work: hook registration, tool
// registration, provider registration, fresh-install ack. OC appears to
// dedupe these internally (we've never seen hooks fire 3-4x per event), so
// this is primarily hygiene — it avoids repeating work that semantically
// only belongs once per process and keeps the code's behavior matching the
// comment that says "once per plugin-load".
let _registerWorkDone = false;

function logDecision(hook, data) {
  if (!DEBUG) return;
  try {
    if (!_debugPath) {
      const debugDir = join(homedir(), '.robot-resources', 'debug');
      mkdirSync(debugDir, { recursive: true });
      _debugPath = join(debugDir, 'plugin-decisions.jsonl');
    }
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      hook,
      ...data,
    });
    appendFileSync(_debugPath, entry + '\n');
  } catch { /* debug logging must never break the plugin */ }
}

// In-process routing classifier. Returns a routing decision for a given
// prompt; called by the local HTTP server's request handler (lib/local-server.js)
// per request. Kept here for telemetry + provider-detection sharing with the
// rest of the plugin code.
//
// `providers` is the subscription-mode constraint (['anthropic'] or null).
async function askRouter(prompt, providers = null, api = null, telemetry = null) {
  const startedAt = Date.now();
  try {
    const detected = getAvailableProviders(api);

    let effective = detected;
    if (providers && providers.length) {
      effective = new Set([...detected].filter((p) => providers.includes(p)));
    }

    if (effective.size === 0) {
      telemetry?.emit('no_providers_detected', {
        has_oc_config: !!api?.config?.models?.providers,
      });
      return { provider: null, model: null, savings: 0 };
    }

    const filteredDb = MODELS_DB.filter((m) => effective.has(m.provider));

    const result = await asyncRoutePrompt(prompt, {
      modelsDb: filteredDb,
      classifierImpl: async (p) => (await classifyWithLlmDetailed(p, { telemetry })).result,
    });

    telemetry?.emit('route_completed', {
      mode: 'in-process',
      task_type: result.task_type,
      provider: result.provider,
      selected_model: result.selected_model,
      savings_percent: result.savings_percent,
      latency_ms: Date.now() - startedAt,
    });

    return {
      provider: result.provider,
      model: result.selected_model,
      savings: result.savings_percent,
    };
  } catch (err) {
    telemetry?.emit('route_failed', {
      mode: 'in-process',
      error_type: err?.constructor?.name ?? 'Error',
      error_message: String(err?.message ?? err).slice(0, 200),
      latency_ms: Date.now() - startedAt,
    });
    return { provider: null, model: null, savings: 0 };
  }
}

function detectSubscriptionMode(config) {
  const profiles = config?.auth?.profiles;
  if (profiles && typeof profiles === 'object') {
    for (const profile of Object.values(profiles)) {
      if (profile?.mode === 'token') return true;
    }
  }
  if (config?.gateway?.auth?.mode === 'token') return true;
  return false;
}

// Hybrid provider detection for in-process routing. Union of:
//   1. api.config.models.providers — explicit provider blocks with apiKey
//   2. api.config.auth.profiles — OC's native auth-profile store (the path
//      bundled provider plugins like anthropic/openai/google actually use).
//      Profile entries look like { provider: 'anthropic', mode: 'api_key' };
//      the actual secret lives in agents/<id>/agent/auth-profiles.json. The
//      presence of a profile entry is sufficient signal that the provider is
//      configured for this OC install.
//   3. env vars — fallback for users who set ANTHROPIC_API_KEY / etc directly
// Empty Set return → caller emits no_providers_detected and skips the
// override; OC then uses its own default model. We intentionally do NOT
// route to the full DB on empty detection — that would mask detection bugs
// and risk routing to a model the user has no key for.
function getAvailableProviders(api) {
  const detected = new Set();
  // 1. api.config (when OC actually populates it for our context)
  try {
    const providers = api?.config?.models?.providers;
    if (providers && typeof providers === 'object' && !Array.isArray(providers)) {
      for (const [name, cfg] of Object.entries(providers)) {
        const key = cfg?.apiKey ?? cfg?.api_key;
        if (typeof key !== 'string') continue;
        if (key === 'n/a' || key === '') continue;
        if (key.startsWith('${') || key.includes('YOUR_')) continue;
        detected.add(name);
      }
    }
  } catch { /* fall through to file-on-disk path */ }

  try {
    const profiles = api?.config?.auth?.profiles;
    if (profiles && typeof profiles === 'object' && !Array.isArray(profiles)) {
      for (const profile of Object.values(profiles)) {
        const provider = profile?.provider;
        if (typeof provider === 'string' && provider) detected.add(provider);
      }
    }
  } catch { /* fall through */ }

  // 2. Read openclaw.json from disk. OC 2026.4.24 doesn't expose
  // auth.profiles or models.providers via api.config at all in some
  // contexts (verified on droplet — api.config.auth was empty at register
  // time even though profiles existed in openclaw.json). Reading directly
  // is the only reliable signal.
  try {
    const ocPath = join(homedir(), '.openclaw', 'openclaw.json');
    const ocCfg = JSON.parse(readFileSync(ocPath, 'utf-8'));
    const profiles = ocCfg?.auth?.profiles;
    if (profiles && typeof profiles === 'object') {
      for (const profile of Object.values(profiles)) {
        if (typeof profile?.provider === 'string' && profile.provider) {
          detected.add(profile.provider);
        }
      }
    }
    const ocProviders = ocCfg?.plugins?.entries;
    // Bundled provider plugins (anthropic, openai, google) self-register
    // when enabled. Treat enabled provider plugin entries as detection too.
    if (ocProviders && typeof ocProviders === 'object') {
      for (const [name, entry] of Object.entries(ocProviders)) {
        if (entry?.enabled && ['anthropic', 'openai', 'google'].includes(name)) {
          detected.add(name);
        }
      }
    }
  } catch { /* file unreadable — env-var path is the last fallback */ }

  // 3. Env vars
  if (process.env.ANTHROPIC_API_KEY) detected.add('anthropic');
  if (process.env.OPENAI_API_KEY) detected.add('openai');
  if (process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY) detected.add('google');

  // robot-resources is OUR provider — never include it in routing candidates.
  detected.delete('robot-resources');

  return detected;
}

function readRrConfig() {
  try {
    return JSON.parse(readFileSync(join(homedir(), '.robot-resources', 'config.json'), 'utf-8'));
  } catch {
    return {};
  }
}

async function checkInstallationStatus({ localServerPort } = {}) {
  const configDir = join(homedir(), '.robot-resources');
  let config = {};
  try {
    config = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf-8'));
  } catch { /* no config = not installed */ }

  const hasConfig = !!config.api_key;
  if (!hasConfig) {
    return {
      status: 'not_installed',
      components: {
        router: { healthy: false, detail: 'not installed' },
        scraper: { healthy: false, detail: 'not installed' },
        platform: { healthy: false, detail: 'not installed' },
        mcp: { healthy: false, detail: 'not installed' },
      },
      summary: 'Robot Resources is not installed. Run: npx robot-resources',
      next_steps: ['Run: npx robot-resources'],
    };
  }

  const probes = await Promise.all([
    probeComponent('router', async () => {
      if (localServerPort == null) return { healthy: false, detail: 'in-process server not bound' };
      return { healthy: true, detail: `in-process on 127.0.0.1:${localServerPort}` };
    }),
    probeComponent('scraper', async () => {
      const oc = JSON.parse(readFileSync(join(homedir(), '.openclaw', 'openclaw.json'), 'utf-8'));
      const has = !!oc?.mcp?.servers?.['robot-resources-scraper'];
      return { healthy: has, detail: has ? 'MCP registered' : 'scraper MCP not registered' };
    }),
    probeComponent('platform', async () => {
      const url = process.env.RR_PLATFORM_URL || config.platform_url || 'https://api.robotresources.ai';
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) return { healthy: false, detail: `HTTP ${res.status}` };
      const data = await res.json();
      return { healthy: data.status === 'ok', detail: data.status === 'ok' ? 'reachable' : `status: ${data.status}` };
    }),
    probeComponent('mcp', async () => {
      const oc = JSON.parse(readFileSync(join(homedir(), '.openclaw', 'openclaw.json'), 'utf-8'));
      const has = !!oc?.plugins?.entries?.['robot-resources-router']?.enabled;
      return { healthy: has, detail: has ? 'plugin registered' : 'plugin not registered' };
    }),
  ]);

  const components = {};
  for (const { name, result } of probes) components[name] = result;

  const healthyCount = Object.values(components).filter((c) => c.healthy).length;
  const total = Object.keys(components).length;
  const status = healthyCount === total ? 'healthy' : healthyCount === 0 ? 'failed' : 'partial';

  const failing = Object.entries(components)
    .filter(([, c]) => !c.healthy)
    .map(([n, c]) => `${n}: ${c.detail}`);

  const next_steps = [];
  if (!components.router.healthy) next_steps.push('Restart OpenClaw to rebind the in-process router');
  if (!components.scraper.healthy) next_steps.push('Register scraper: npx robot-resources');
  if (!components.platform.healthy) next_steps.push('Check API key in ~/.robot-resources/config.json');
  if (!components.mcp.healthy) next_steps.push('Reinstall plugin: npx robot-resources');

  return {
    status,
    components,
    summary: status === 'healthy'
      ? `All ${total} components healthy.`
      : `${healthyCount}/${total} healthy. Issues: ${failing.join('; ')}`,
    next_steps,
  };
}

async function probeComponent(name, fn) {
  try {
    return { name, result: await fn() };
  } catch (err) {
    const detail = err.name === 'AbortError' ? 'timeout' : 'unreachable';
    return { name, result: { healthy: false, detail } };
  }
}

const robotResourcesPlugin = {
  id: 'robot-resources-router',
  name: 'Robot Resources',
  description: 'Cost-optimized model routing + token-compressed web fetching',

  register(api) {
    const isSubscription = detectSubscriptionMode(api.config);

    // Construct telemetry client once. Safe if api_key is missing — emit() no-ops.
    // onHealHint receives allowlisted hints from the platform's response:
    //   - 'rerun_wizard' → surface a nag in the next user-facing message
    //   - (legacy 'reheal_router' is ignored — no daemon to heal)
    const rrConfig = readRrConfig();
    let _pendingNag = null;
    const telemetry = createTelemetry({
      platformUrl: rrConfig.platform_url,
      apiKey: rrConfig.api_key,
      onHealHint: (hint) => {
        if (hint === 'rerun_wizard') {
          _pendingNag = 'Robot Resources needs attention — run `npx robot-resources` to reinstall.';
        }
      },
    });

    // Heartbeat — one event per plugin-load *process*, not per register()
    // call. OC re-invokes register() for multiple internal subsystems in a
    // single session, and we don't want each call to count as a separate
    // adoption event. The first call emits; subsequent calls in the same
    // process are skipped (the plugin is already loaded).
    if (!_registerEmitted) {
      _registerEmitted = true;
      telemetry.emit('plugin_register', {
        subscription_mode: isSubscription,
        mode: 'in-process',
      });
    }

    runUpdateCheck({ logger: api.logger, telemetry });

    runBufferFlush({
      platformUrl: rrConfig.platform_url,
      apiKey: rrConfig.api_key,
      logger: api.logger,
      telemetry,
    });

    if (isSubscription) {
      api.logger.info('[robot-resources] Subscription mode detected — routing restricted to Anthropic models');
    }

    // Per-process setup runs exactly once. Subsequent register() calls from
    // OC's internal subsystems skip this block entirely.
    if (_registerWorkDone) return;
    _registerWorkDone = true;

    let freshInstall = false;
    const ackPath = join(homedir(), '.robot-resources', '.install-ack');
    try {
      const statusPath = join(homedir(), '.robot-resources', 'wizard-status.json');
      const status = JSON.parse(readFileSync(statusPath, 'utf-8'));
      if (status.completed_at && status.health_report) {
        let alreadyAcked = false;
        try {
          alreadyAcked = readFileSync(ackPath, 'utf-8').trim() === status.completed_at;
        } catch { /* no ack file = not yet acknowledged */ }

        if (!alreadyAcked) {
          freshInstall = status;
          api.logger.info('[robot-resources] Fresh installation detected — will confirm to user');
        }
      }
    } catch { /* no wizard-status or parse error */ }

    // Hard-constrain routing to anthropic. The local HTTP server forwards
    // unconditionally to api.anthropic.com — picking a non-anthropic model
    // would cause anthropic to 404. Multi-provider support is a separate
    // refactor; for now the upstream is anthropic-only regardless of which
    // providers OC has configured. (Subscription-mode detection is informational.)
    const providers = ['anthropic'];

    // Snapshot detected providers ONCE at register time. OC's `api.config`
    // is populated during register() but goes empty afterward — the plugin
    // SDK doesn't keep a live config reference for handlers that fire later.
    // So we materialise the detection now and pass the resulting Set to the
    // server. (Subscription mode already constrains via `providers` above.)
    const detectedProviders = getAvailableProviders(api);
    api.logger.info(
      `[robot-resources] Detected providers at register: [${[...detectedProviders].join(',') || '(none)'}]`,
    );

    // Bind the in-process Anthropic-messages server. The port is fixed
    // (18790) so the static openclaw.json baseUrl stays valid across plugin
    // restarts; falls back to OS-chosen if 18790 is busy.
    let _localServerPort = null;
    const _localServerStartPromise = startLocalServer({
      api,
      telemetry,
      providers,
      detectedProviders,
    }).then(({ port }) => { _localServerPort = port; })
      .catch((err) => {
        api.logger.warn(`[robot-resources] local server failed to bind: ${err?.message}`);
        telemetry.emit('local_server_bind_failed', {
          error: String(err?.message || err).slice(0, 200),
        });
      });

    api.on('message_sending', (event, _ctx) => {
      let suffix = '';

      if (freshInstall) {
        const claimUrl = freshInstall.claim_url;
        suffix += '\n\n✅ **Robot Resources installed successfully.** [RR:OK]';
        suffix += '\n\nYour agent now has:';
        suffix += '\n• **Router** — intelligent LLM routing (60-90% cost savings)';
        suffix += '\n• **Scraper** — web content compression (91% token reduction)';
        suffix += '\n\nStart a new conversation to activate all tools.';
        suffix += '\nRouting, scraping, and health checks will be available immediately.';
        if (claimUrl) suffix += `\n\n📊 Dashboard: ${claimUrl}`;
        try { writeFileSync(ackPath, freshInstall.completed_at, { mode: 0o600 }); } catch { /* best-effort */ }
        freshInstall = false;
      }

      if (_pendingNag) {
        suffix += `\n\n⚠️ _${_pendingNag}_`;
        _pendingNag = null;
      }

      if (!suffix) return;
      return { content: event.content + suffix };
    }, { priority: -10 });

    api.on('after_tool_call', async (event, _ctx) => {
      if (!event) return;
      const tool = event.tool || 'unknown';
      const params = event.params || {};
      let result = event.result;

      if (typeof result === 'string' && result.length > 500) {
        result = result.slice(0, 500) + '...';
      } else if (typeof result === 'object') {
        const serialized = JSON.stringify(result);
        result = serialized.length > 500 ? serialized.slice(0, 500) + '...' : serialized;
      }

      logDecision('after_tool_call', {
        tool,
        params: typeof params === 'object' ? Object.keys(params) : [],
        result: result ?? null,
        success: event.exitCode === undefined || event.exitCode === 0,
      });
    }, { priority: 100 });

    api.on('llm_output', async (event, _ctx) => {
      if (!event) return;
      const response = event.response || event.output || {};
      const toolCalls = response.tool_calls || response.toolCalls || [];

      logDecision('llm_output', {
        has_content: !!response.content,
        tool_calls: Array.isArray(toolCalls) ? toolCalls.map((t) => t.name || t.function?.name || 'unknown') : [],
        tool_count: Array.isArray(toolCalls) ? toolCalls.length : 0,
      });
    }, { priority: 100 });

    api.on('before_tool_call', async (event, _ctx) => {
      if (event.tool !== 'web_fetch') return;

      const url = event.params?.url;
      if (!url) return;

      api.logger.info(`[robot-resources] Redirecting web_fetch → scraper_compress_url: ${url}`);
      logDecision('before_tool_call', {
        original_tool: 'web_fetch',
        redirected_to: 'scraper_compress_url',
        url,
      });

      return {
        toolOverride: 'scraper_compress_url',
        paramsOverride: {
          url,
          mode: 'auto',
        },
      };
    }, { priority: 10 });

    if (typeof api.registerTool === 'function') {
      api.registerTool({
        name: 'check_installation_status',
        description: 'Check Robot Resources installation health. Returns structured report with component status and actionable next steps.',
        parameters: {},
        async execute() {
          return await checkInstallationStatus({ localServerPort: _localServerPort });
        },
      });
    }

    // Register as a real OC provider with a single virtual model
    // robot-resources/auto. When the user sets that as their defaultModel,
    // OC's agent runtime dispatches LLM calls to baseUrl below — which is
    // our in-process HTTP server. The server runs the JS classifier on the
    // prompt, picks a real Anthropic model, and forwards to api.anthropic.com.
    //
    // We use baseUrl dispatch instead of plugin SDK hooks because OC's agent
    // runtime (the path Telegram → agent uses) does not invoke ANY plugin
    // SDK hooks (before_model_resolve, before_agent_start, wrapStreamFn,
    // etc.). Provider catalog dispatch with baseUrl + api: 'anthropic-
    // messages' IS alive in that runtime — same path the bundled anthropic
    // provider uses.
    if (typeof api.registerProvider === 'function') {
      // Static model definition used in both configPatch (which OC validates
      // strictly — no `provider` key allowed there) and catalog.run output.
      // The model belongs to `robot-resources` because of its parent key in
      // models.providers; no need to repeat the provider field on the model.
      const ROBOT_RESOURCES_MODEL_DEF = {
        id: 'auto',
        name: 'Robot Resources Auto',
        api: 'anthropic-messages',
        reasoning: false,
        input: ['text', 'image'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 8_192,
      };

      // catalog.run is awaited by OC each time it builds the provider
      // catalog. We block on the local server bind so the returned baseUrl
      // points at the OS-chosen port. If the bind failed, return a config
      // without baseUrl — OC will surface the missing-transport error
      // visibly rather than silently routing to a dead URL.
      const buildProviderConfig = async () => {
        await _localServerStartPromise;
        const cfg = {
          apiKey: 'n/a',
          api: 'anthropic-messages',
          authHeader: false,
          models: [ROBOT_RESOURCES_MODEL_DEF],
        };
        if (_localServerPort != null) cfg.baseUrl = `http://127.0.0.1:${_localServerPort}`;
        return cfg;
      };

      api.registerProvider({
        id: 'robot-resources',
        label: 'Robot Resources',
        docsPath: '/providers/models',
        auth: [{
          id: 'local',
          label: 'No additional setup',
          hint: 'Routing reuses your existing Anthropic key',
          kind: 'custom',
          run: async (_authCtx) => ({
            profiles: [{
              profileId: 'robot-resources:default',
              credential: { type: 'token', provider: 'robot-resources', token: 'n/a' },
            }],
            configPatch: {
              models: { providers: { 'robot-resources': await buildProviderConfig() } },
              agents: { defaults: { models: { 'robot-resources/auto': {} } } },
            },
            defaultModel: 'robot-resources/auto',
            notes: ['Auto-routes between Anthropic models per prompt. Uses your existing Anthropic key.'],
          }),
        }],
        catalog: {
          order: 'simple',
          run: async (_catCtx) => ({ provider: await buildProviderConfig() }),
        },
        staticCatalog: {
          order: 'simple',
          run: async () => ({ provider: await buildProviderConfig() }),
        },
      });
      api.logger.info('[robot-resources] Provider registered: robot-resources/auto');
    } else {
      api.logger.warn('[robot-resources] api.registerProvider not available — provider not registered');
    }
  },
};

export default robotResourcesPlugin;
export { askRouter, detectSubscriptionMode, getAvailableProviders };
