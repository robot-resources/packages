/**
 * Anthropic SDK adapter for the Node auto-attach path.
 *
 * Mechanism: the SDK constructor reads `ANTHROPIC_BASE_URL` (verified
 * against @anthropic-ai/sdk client.js — `baseURL = readEnv('ANTHROPIC_BASE_URL')`).
 * `auto.cjs` sets that env var BEFORE this module loads. Our job here is to:
 *
 *   1. Start the in-process routing server (reuses `local-server.js` from
 *      the OC plugin path — already standalone, accepts api: null).
 *   2. If the server bound on a fallback port (primary 18790 was in use,
 *      e.g. an OC plugin already running on this machine), update the env
 *      var so the SDK aims at the right place.
 *   3. Emit `adapter_attached` telemetry so we can track real-world adoption.
 *
 * Failure modes:
 *   - Both port bindings fail → env var stays at `:18790`, SDK gets
 *     ECONNREFUSED on first call. Visible failure with telemetry.
 *   - No api_key in ~/.robot-resources/config.json → telemetry skipped,
 *     server still routes (the wizard should have provisioned one; if it
 *     didn't, this is a no-op load).
 */

import { startLocalServer } from '../local-server.js';
import { emitAttachEvent, detectProvidersFromEnv, readSdkVersion, buildSharedTelemetry } from './_attach.js';
import { ensureLocalServerStarted } from './_local-server-once.js';

/**
 * Boot (or reuse) the local server + emit telemetry. Called once per process
 * from `auto.cjs` after the env var is set. Phase 4 added more adapters;
 * the local server now binds exactly once per process via the singleton
 * coordinator regardless of how many adapters call `attach()`.
 */
export async function attach({ primaryBaseUrl } = {}) {
  const detectedProviders = detectProvidersFromEnv();
  const sdkVersion = readSdkVersion('@anthropic-ai/sdk');

  let bound;
  try {
    bound = await ensureLocalServerStarted({
      starter: () => startLocalServer({
        api: null,
        telemetry: buildSharedTelemetry(),
        detectedProviders,
      }),
    });
  } catch (err) {
    await emitAttachEvent({
      sdk: 'anthropic',
      sdk_version: sdkVersion,
      attached: false,
      reason: 'local_server_throw',
      error_message: String(err?.message ?? err).slice(0, 200),
      providers_detected: [...detectedProviders],
    });
    return;
  }

  if (!bound?.port) {
    await emitAttachEvent({
      sdk: 'anthropic',
      sdk_version: sdkVersion,
      attached: false,
      reason: 'local_server_bind_failed',
      providers_detected: [...detectedProviders],
    });
    return;
  }

  // If the primary port (18790) was in use and we landed on an OS-chosen
  // fallback, the env var auto.cjs set is now wrong. Update it so the SDK
  // talks to the actual bound port.
  const PRIMARY_PORT = 18790;
  if (bound.port !== PRIMARY_PORT) {
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${bound.port}/anthropic`;
  }

  await emitAttachEvent({
    sdk: 'anthropic',
    sdk_version: sdkVersion,
    attached: true,
    bound_port: bound.port,
    fallback_port: bound.port !== PRIMARY_PORT,
    primary_base_url: primaryBaseUrl ?? null,
    providers_detected: [...detectedProviders],
  });
}
