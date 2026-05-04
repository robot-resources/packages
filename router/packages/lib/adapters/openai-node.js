/**
 * OpenAI SDK adapter for the Node auto-attach path.
 *
 * Mechanism: same env-var trick as `anthropic-node.js`. The OpenAI SDK
 * constructor reads `OPENAI_BASE_URL` directly (verified in `openai`
 * `client.js:71` — `baseURL = readEnv('OPENAI_BASE_URL')`). `auto.cjs`
 * sets that env var BEFORE user code runs and starts the in-process
 * routing server (already supports the `/openai/v1` URL prefix in
 * `local-server.js`). When the user creates `new OpenAI()`, every method
 * routes through us.
 *
 * Phase 1 already started the local server for the Anthropic path. If
 * both adapters are present in the same process, only one server bind
 * happens (singleton in `_attach.js`). Telemetry fires per-SDK.
 */

import { startLocalServer } from '../local-server.js';
import { emitAttachEvent, detectProvidersFromEnv, readSdkVersion, buildSharedTelemetry } from './_attach.js';
import { ensureLocalServerStarted } from './_local-server-once.js';

/**
 * Boot (or reuse) the local server + emit telemetry for the OpenAI adapter.
 * Called once per process from `auto.cjs` after the env var is set.
 */
export async function attach({ primaryBaseUrl } = {}) {
  const detectedProviders = detectProvidersFromEnv();
  const sdkVersion = readSdkVersion('openai');

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
      sdk: 'openai',
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
      sdk: 'openai',
      sdk_version: sdkVersion,
      attached: false,
      reason: 'local_server_bind_failed',
      providers_detected: [...detectedProviders],
    });
    return;
  }

  const PRIMARY_PORT = 18790;
  if (bound.port !== PRIMARY_PORT) {
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${bound.port}/openai/v1`;
  }

  await emitAttachEvent({
    sdk: 'openai',
    sdk_version: sdkVersion,
    attached: true,
    bound_port: bound.port,
    fallback_port: bound.port !== PRIMARY_PORT,
    primary_base_url: primaryBaseUrl ?? null,
    providers_detected: [...detectedProviders],
  });
}
