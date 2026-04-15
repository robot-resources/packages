import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let _pluginVersion = 'unknown';
try {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
  _pluginVersion = pkg.version || 'unknown';
} catch {
  // Plugin is running from an unusual layout; telemetry still emits with 'unknown'
}

export const PLUGIN_VERSION = _pluginVersion;

const DEFAULT_PLATFORM_URL = 'https://api.robotresources.ai';
const EMIT_TIMEOUT_MS = 5_000;

/**
 * Creates a fire-and-forget telemetry client.
 *
 * `emit(eventType, payload)` never throws and never blocks the hot path.
 * Every event auto-merges `{plugin_version, node_version, platform}` into
 * the payload so downstream analytics can slice by version without the
 * caller having to remember.
 *
 * When `apiKey` is missing, `emit()` is a no-op — we can't authenticate.
 */
export function createTelemetry({ platformUrl, apiKey } = {}) {
  const url = (platformUrl || DEFAULT_PLATFORM_URL).replace(/\/+$/, '');

  function emit(eventType, payload = {}) {
    if (!apiKey || !eventType) return;
    const body = {
      product: 'plugin',
      event_type: eventType,
      payload: {
        plugin_version: PLUGIN_VERSION,
        node_version: process.version,
        platform: process.platform,
        ...payload,
      },
    };

    // Fire-and-forget. Do not await. Do not propagate errors.
    fetch(`${url}/v1/telemetry`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(EMIT_TIMEOUT_MS),
    }).catch(() => {
      // Swallow. Telemetry must never break the plugin.
    });
  }

  return { emit, PLUGIN_VERSION };
}
