/**
 * Robot Resources plugin for OpenClaw — core implementation.
 *
 * Loaded lazily by ../index.js (the shim) so a bad release can be caught by
 * safe-load.js and rolled back. Do not add top-level side effects here.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { createTelemetry } from './telemetry.js';
import { runUpdateCheck } from './update-check.js';
import { runBufferFlush } from './buffer-flush.js';
import { runPluginHeal } from './plugin-heal.js';
import { asyncRoutePrompt } from './routing/router.js';
import { MODELS_DB } from './routing/selector.js';
import { classifyWithLlmDetailed } from './routing/classify.js';

const DEFAULT_ROUTER_URL = 'http://localhost:3838';

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

// ── Router auto-restart ─────────────────────────────────────────────────────

let _restartAttempted = false;

async function tryStartRouter(routerUrl, telemetry) {
  if (_restartAttempted) return false;
  _restartAttempted = true;

  telemetry?.emit('router_auto_restart_attempted', { router_url: routerUrl });

  const home = homedir();
  const venvPython = process.platform === 'win32'
    ? join(home, '.robot-resources', '.venv', 'Scripts', 'python.exe')
    : join(home, '.robot-resources', '.venv', 'bin', 'python3');

  if (!existsSync(venvPython)) {
    telemetry?.emit('router_auto_restart_failed', { reason: 'venv_not_found' });
    return false;
  }

  try {
    const child = spawn(venvPython, ['-m', 'robot_resources.cli.main', 'start'], {
      detached: true,
      stdio: 'ignore',
      cwd: join(home, '.robot-resources'),
    });
    child.unref();
  } catch (err) {
    telemetry?.emit('router_auto_restart_failed', { reason: 'spawn_failed', error: err?.message });
    return false;
  }

  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 1_000));
    try {
      const res = await fetch(`${routerUrl}/health`, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) {
        telemetry?.emit('router_auto_restart_succeeded', { attempts: i + 1 });
        return true;
      }
    } catch { /* not ready yet */ }
  }
  telemetry?.emit('router_auto_restart_failed', { reason: 'health_timeout' });
  return false;
}

// HTTP-only routing path. Kept for one release as a fallback when the
// in-process path throws unexpectedly. Deleted entirely in PR 3.
async function askRouterHttp(routerUrl, prompt, providers = null) {
  try {
    const body = { prompt };
    if (providers) body.providers = providers;

    const resp = await fetch(`${routerUrl}/v1/route`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3_000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return {
      provider: data.provider || 'anthropic',
      model: data.model || null,
      savings: data.savings_percent || 0,
    };
  } catch {
    return null;
  }
}

// In-process routing with HTTP fallback. The strategic shift of PR 2.
//
// `providers` is the subscription-mode constraint (['anthropic'] or null).
// `api` and `telemetry` are required for hybrid provider detection +
// observability (route_completed / route_failed / classifier_fallback /
// no_providers_detected).
async function askRouter(routerUrl, prompt, providers = null, api = null, telemetry = null) {
  const startedAt = Date.now();
  try {
    const detected = getAvailableProviders(api);

    let effective = detected;
    if (providers && providers.length) {
      effective = new Set([...detected].filter((p) => providers.includes(p)));
    }

    if (effective.size === 0) {
      // Detection found NOTHING. Routing to the full DB here would risk
      // returning a model the user has no key for — OC would then fail the
      // LLM call while route_completed telemetry looks healthy. Worse, it
      // would mask hybrid-detection bugs (e.g. if OC ever changes its config
      // schema and Object.entries silently surfaces nothing). Safer: surface
      // the detection failure as telemetry and let OC fall through to its
      // own default model. The before_model_resolve hook checks
      // !decision?.model and skips the override.
      telemetry?.emit('no_providers_detected', {
        has_oc_config: !!api?.config?.models?.providers,
      });
      return { provider: null, model: null, savings: 0 };
    }

    const filteredDb = MODELS_DB.filter((m) => effective.has(m.provider));

    // classifierImpl is invoked ONLY when keyword confidence falls below
    // CONFIDENCE_THRESHOLD (~30% of prompts). The slow path's telemetry
    // (`classifier_fallback`) is emitted from inside classifyWithLlmDetailed
    // so it only fires when the classifier actually ran — preserving the
    // keyword fast-path performance characteristic.
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
    // HTTP fallback: belt-and-suspenders for one release. Deleted in PR 3.
    return askRouterHttp(routerUrl, prompt, providers);
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
//   1. api.config.models.providers — OBJECT keyed by provider name (the value
//      shape mirrors what registerProvider's configPatch produces, see
//      ~lines 537-547 of the deleted block).
//   2. env vars — the migration guide tells users to set ANTHROPIC_API_KEY /
//      OPENAI_API_KEY / GOOGLE_API_KEY / GEMINI_API_KEY, so config-only
//      detection misses the well-configured cohort.
// Empty Set return → caller emits no_providers_detected and skips the
// override; OC then uses its own default model. We intentionally do NOT
// route to the full DB on empty detection — that would mask detection bugs
// and risk routing to a model the user has no key for.
function getAvailableProviders(api) {
  const detected = new Set();
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
  } catch { /* malformed config — env-var path is the fallback */ }

  if (process.env.ANTHROPIC_API_KEY) detected.add('anthropic');
  if (process.env.OPENAI_API_KEY) detected.add('openai');
  if (process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY) detected.add('google');

  return detected;
}

function readRrConfig() {
  try {
    return JSON.parse(readFileSync(join(homedir(), '.robot-resources', 'config.json'), 'utf-8'));
  } catch {
    return {};
  }
}

async function checkInstallationStatus(routerUrl) {
  const configDir = join(homedir(), '.robot-resources');
  let config = {};
  try {
    config = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf-8'));
  } catch { /* no config = not installed */ }

  const hasConfig = !!config.api_key;
  if (!hasConfig) {
    try {
      readFileSync(join(configDir, 'config.json'), 'utf-8');
    } catch {
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
  }

  const probes = await Promise.all([
    probeComponent('router', async () => {
      const res = await fetch(`${routerUrl}/health`, { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) return { healthy: false, detail: `HTTP ${res.status}` };
      const data = await res.json();
      return (data.status === 'healthy' || data.status === 'degraded')
        ? { healthy: true, detail: `running (v${data.version || 'unknown'})` }
        : { healthy: false, detail: `status: ${data.status}` };
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
      const has = !!oc?.plugins?.entries?.['openclaw-plugin']?.enabled;
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
  if (!components.router.healthy) next_steps.push('Start router: npx robot-resources');
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
  id: 'openclaw-plugin',
  name: 'Robot Resources',
  description: 'Cost-optimized model routing + token-compressed web fetching',

  register(api) {
    const pluginConfig = api.pluginConfig || {};
    const routerUrl = pluginConfig.routerUrl || DEFAULT_ROUTER_URL;
    const isSubscription = detectSubscriptionMode(api.config);

    // Construct telemetry client once. Safe if api_key is missing — emit() no-ops.
    // onHealHint receives allowlisted hints from the platform's response:
    //   - 'reheal_router' → force a bypass-throttle heal attempt
    //   - 'rerun_wizard'  → surface a nag in the next user-facing message
    const rrConfig = readRrConfig();
    let _pendingNag = null;
    const telemetry = createTelemetry({
      platformUrl: rrConfig.platform_url,
      apiKey: rrConfig.api_key,
      onHealHint: (hint) => {
        if (hint === 'reheal_router') {
          // Clear the plugin-heal throttle so the next runPluginHeal call
          // actually runs instead of short-circuiting. Server-triggered
          // re-heal bypasses the 1h client throttle by design.
          try {
            const throttle = join(homedir(), '.robot-resources', '.plugin-heal-check');
            if (existsSync(throttle)) unlinkSync(throttle);
          } catch { /* throttle removal is best-effort */ }
          runPluginHeal({
            routerUrl,
            telemetry,
            logger: api.logger,
            tryStartRouter: (url, t) => tryStartRouter(url, t),
          });
        } else if (hint === 'rerun_wizard') {
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
        router_url: routerUrl,
        subscription_mode: isSubscription,
        mode: 'in-process',
      });
    }

    // Fire-and-forget daily update check. runUpdateCheck is self-wrapped in
    // try/catch — it cannot throw up and cannot block register().
    runUpdateCheck({ logger: api.logger, telemetry });

    // Fire-and-forget: flush any buffered router telemetry left on disk.
    // The router buffers events to JSONL when the direct POST fails; if the
    // router dies before the background sync drains them, the plugin ships
    // them on next session start.
    runBufferFlush({
      platformUrl: rrConfig.platform_url,
      apiKey: rrConfig.api_key,
      logger: api.logger,
      telemetry,
    });

    // Fire-and-forget: plugin-side self-heal. Runs on every OC gateway
    // start regardless of whether OC routes anything — probes /health and
    // if the router is dead, tries to revive it (enable-linger +
    // systemctl --user restart + detached spawn). Throttled to once/hr.
    // This is the anchor for users whose router died after install —
    // the router's own self_heal only runs at router startup, and dead
    // routers can't self-heal.
    runPluginHeal({
      routerUrl,
      telemetry,
      logger: api.logger,
      tryStartRouter: (url, t) => tryStartRouter(url, t),
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

    const providers = isSubscription ? ['anthropic'] : null;
    let lastRouting = null;

    api.on('before_model_resolve', async (event, _ctx) => {
      const prompt = event.prompt || '';
      if (!prompt) return;

      let decision = await askRouter(routerUrl, prompt, providers, api, telemetry);

      if (!decision?.model) {
        const started = await tryStartRouter(routerUrl, telemetry);
        if (started) {
          decision = await askRouter(routerUrl, prompt, providers, api, telemetry);
        }
      }

      if (!decision?.model) {
        api.logger.warn('[robot-resources] Router offline — routing disabled for this call. Run: rr-router start');
        telemetry.emit('router_offline_warned', { router_url: routerUrl });
        return;
      }

      lastRouting = decision;
      api.logger.info(
        `[robot-resources] Routing: ${decision.model} (${decision.savings}% savings)`,
      );
      logDecision('before_model_resolve', {
        input: prompt.slice(0, 200),
        decision: { model: decision.model, provider: decision.provider, savings: decision.savings },
      });

      return {
        modelOverride: decision.model,
        providerOverride: decision.provider,
      };
    }, { priority: 10 });

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

      if (lastRouting) {
        suffix += `\n\n⚡ _Routed → ${lastRouting.model} (${lastRouting.savings}% savings)_`;
        lastRouting = null;
      }

      // Server-triggered nag when the platform has seen repeated install
      // failures / heal failures from this api_key. Fires at most once
      // per process — we clear after surfacing so we don't spam the user.
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
          return await checkInstallationStatus(routerUrl);
        },
      });
    }

    // PR 2: provider registration removed. With in-process routing, OC handles
    // requests using the user's own provider keys via modelOverride/
    // providerOverride from before_model_resolve — no proxy provider needed.
    // See business/refactor-router-in-process.md.
  },
};

export default robotResourcesPlugin;
export { DEFAULT_ROUTER_URL, askRouter, askRouterHttp, detectSubscriptionMode, getAvailableProviders };
