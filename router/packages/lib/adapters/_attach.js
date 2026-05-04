/**
 * Shared adapter helpers for the auto-attach path.
 *
 * Phase 1 needs only the telemetry emitter. Phase 4 will add cross-adapter
 * coordination (provider-detection, bound-port discovery, retry policy).
 *
 * Telemetry shape `adapter_attached`: fired ONCE per agent process per SDK,
 * regardless of how many Anthropic instances the user code creates. Payload
 * is queryable in Supabase to track real-world adoption + failure modes
 * across bundlers, Node versions, and SDK versions.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createTelemetry } from '../telemetry.js';

const require = createRequire(import.meta.url);

/**
 * Read api_key once and cache. Used by both `emitAttachEvent` (its own
 * fetch path) and `buildSharedTelemetry` (the in-process server path).
 */
function readApiKey() {
  try {
    const cfgPath = join(homedir(), '.robot-resources', 'config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    return cfg.api_key || null;
  } catch {
    return null;
  }
}

/**
 * Process-singleton telemetry instance shared by all three adapters and
 * passed into `startLocalServer({ telemetry })`. Without this, the local
 * server's `telemetry?.emit?.('route_completed', ...)` short-circuits to
 * a no-op — the routing happens but never reports back to Supabase.
 *
 * Phase 10 fix. Pre-Phase-10, each adapter passed `telemetry: null` to
 * `startLocalServer`. Result: `route_completed`, `local_server_started`,
 * `route_failed`, `no_providers_detected`, `local_server_no_key`,
 * `local_server_upstream_failed` all evaporated for non-OC users.
 *
 * Returns null when the user has no api_key — `emit()` is then a no-op
 * inside `createTelemetry` itself, but returning null lets local-server's
 * own `telemetry?.emit?.()` short-circuit cheaper.
 */
let _sharedTelemetry;
export function buildSharedTelemetry() {
  if (_sharedTelemetry !== undefined) return _sharedTelemetry;
  const apiKey = readApiKey();
  if (!apiKey) {
    _sharedTelemetry = null;
    return _sharedTelemetry;
  }
  const platformUrl = process.env.RR_PLATFORM_URL || undefined;
  _sharedTelemetry = createTelemetry({ apiKey, platformUrl });
  return _sharedTelemetry;
}

// Test-only reset so vitest can re-exercise the singleton between cases.
export function _resetSharedTelemetryForTests() {
  _sharedTelemetry = undefined;
}

/**
 * Best-effort POST of `adapter_attached` to the platform telemetry endpoint.
 *
 * Reads api_key from ~/.robot-resources/config.json (the same file the
 * wizard writes at signup). If the file is missing or has no api_key,
 * we silently skip — telemetry is optional, the SDK still routes either way.
 *
 * Never throws back into the host agent. Never blocks longer than the
 * fetch timeout.
 */
export async function emitAttachEvent({ sdk, sdk_version = null, attached, ...rest }) {
  const apiKey = readApiKey();
  if (!apiKey) return;

  const platformUrl = process.env.RR_PLATFORM_URL || 'https://api.robotresources.ai';
  try {
    await fetch(`${platformUrl}/v1/telemetry`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        product: 'router',
        event_type: 'adapter_attached',
        payload: {
          sdk,
          sdk_version,
          attached,
          language: 'node',
          // Phase 1 only loads via CJS `--require`. ESM-only agents that use
          // `--import` will land in Phase 1.5 with `module.register()` hooks.
          module_system: 'cjs',
          node_version: process.version,
          platform: process.platform,
          ...rest,
        },
      }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // Best-effort — never let telemetry break the agent.
  }
}

/**
 * Detect which provider keys are present in the environment. Used by the
 * local server's classifier to filter MODELS_DB to only labs the user can
 * actually call. Mirrors the in-OC `getAvailableProviders` logic but reads
 * env vars instead of OC config.
 */
export function detectProvidersFromEnv() {
  const providers = new Set();
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) providers.add('anthropic');
  if (process.env.OPENAI_API_KEY) providers.add('openai');
  if (process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY) providers.add('google');
  return providers;
}

/**
 * Read the user's installed SDK version from package.json. Stamped on the
 * telemetry payload so we can spot version-specific breakage (SDK upgrades
 * can rename methods or change the env-var contract).
 */
export function readSdkVersion(sdkPackage) {
  try {
    return require(`${sdkPackage}/package.json`).version;
  } catch {
    return null;
  }
}
