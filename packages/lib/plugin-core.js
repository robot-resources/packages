/**
 * Robot Resources plugin for OpenClaw — core implementation.
 *
 * Loaded lazily by ../index.js (the shim) so a bad release can be caught by
 * safe-load.js and rolled back. Do not add top-level side effects here.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { createTelemetry } from './telemetry.js';
import { runUpdateCheck } from './update-check.js';
import { runBufferFlush } from './buffer-flush.js';

const DEFAULT_ROUTER_URL = 'http://localhost:3838';

const DEBUG = !!process.env.RR_DEBUG;
let _debugPath = null;

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

const ROUTER_MODELS = [
  'claude-sonnet-4-20250514',
  'claude-haiku-4-5-20251001',
  'claude-opus-4-20250514',
];

async function askRouter(routerUrl, prompt, providers = null) {
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

function buildModelDefinition(modelId) {
  return {
    id: modelId,
    name: modelId,
    api: 'anthropic-messages',
    reasoning: false,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  };
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
    const rrConfig = readRrConfig();
    const telemetry = createTelemetry({
      platformUrl: rrConfig.platform_url,
      apiKey: rrConfig.api_key,
    });

    // Heartbeat — one event per plugin load. Without this, a healthy install
    // on the latest version emits nothing and we can't tell from telemetry
    // whether the plugin is loading at all.
    telemetry.emit('plugin_register', {
      router_url: routerUrl,
      subscription_mode: isSubscription,
    });

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

    if (isSubscription) {
      api.logger.info('[robot-resources] Subscription mode detected — routing restricted to Anthropic models');
    }

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

      let decision = await askRouter(routerUrl, prompt, providers);

      if (!decision?.model) {
        const started = await tryStartRouter(routerUrl, telemetry);
        if (started) {
          decision = await askRouter(routerUrl, prompt, providers);
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

    if (isSubscription) {
      api.logger.info('[robot-resources] Subscription mode — skipping provider registration (routing via hook only)');
      return;
    }

    api.registerProvider({
      id: 'robot-resources',
      label: 'Robot Resources',
      docsPath: '/providers/models',
      auth: [
        {
          id: 'local',
          label: 'Local Router proxy',
          hint: 'Route requests through the Robot Resources Router for cost optimization',
          kind: 'custom',
          async run(ctx) {
            const baseUrlInput = await ctx.prompter.text({
              message: 'Robot Resources Router URL',
              initialValue: routerUrl,
              validate: (value) => {
                try { new URL(value); } catch { return 'Enter a valid URL'; }
                return undefined;
              },
            });

            const baseUrl = baseUrlInput.trim().replace(/\/+$/, '');

            return {
              profiles: [
                {
                  profileId: 'robot-resources:local',
                  credential: {
                    type: 'token',
                    provider: 'robot-resources',
                    token: 'n/a',
                  },
                },
              ],
              configPatch: {
                models: {
                  providers: {
                    'robot-resources': {
                      baseUrl,
                      apiKey: 'n/a',
                      api: 'anthropic-messages',
                      authHeader: false,
                      models: ROUTER_MODELS.map(buildModelDefinition),
                    },
                  },
                },
              },
              defaultModel: `robot-resources/${ROUTER_MODELS[0]}`,
              notes: [
                'Robot Resources Router must be running (npx robot-resources).',
                'Requests are routed through localhost:3838 for cost optimization.',
              ],
            };
          },
        },
      ],
    });
  },
};

export default robotResourcesPlugin;
export { DEFAULT_ROUTER_URL, ROUTER_MODELS, askRouter, detectSubscriptionMode };
