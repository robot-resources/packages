/**
 * Google Generative AI SDK adapter for the Node auto-attach path.
 *
 * Mechanism: monkey-patch (not env var). Google's `@google/generative-ai`
 * SDK doesn't read a base-url env var (verified against `dist/index.js`).
 * Instead it composes the URL inline:
 *
 *     `${requestOptions?.baseUrl || DEFAULT_BASE_URL}/${apiVersion}/${model}:${task}`
 *
 * The `requestOptions.baseUrl` field is per-`getGenerativeModel()` call.
 * We patch `GoogleGenerativeAI.prototype.getGenerativeModel` to inject
 * our localhost URL into `requestOptions.baseUrl` whenever the user
 * doesn't pass one explicitly. The user's API key flows through
 * unchanged — Google's SDK reads it from the `GoogleGenerativeAI`
 * constructor and adds it to the request as a query param; our local
 * server's `/google/v1beta` shape passes it through.
 *
 * Lazy attach: hooks `Module._load` so we patch the SDK on first import,
 * not eagerly. If the user's project doesn't have `@google/generative-ai`
 * installed, this adapter is a complete no-op.
 */

import { createRequire } from 'node:module';
import { startLocalServer } from '../local-server.js';
import { emitAttachEvent, detectProvidersFromEnv, readSdkVersion, buildSharedTelemetry } from './_attach.js';
import { ensureLocalServerStarted } from './_local-server-once.js';

const require = createRequire(import.meta.url);
const _NodeModule = require('node:module');

let _serverPort = null;
let _patchInstalled = false;

/**
 * Boot (or reuse) the local server + register a deferred patch on the
 * Google SDK's `Module._load` resolution. Telemetry fires when the
 * patch is wired (not when the SDK is actually imported).
 */
export async function attach({ primaryBaseUrl } = {}) {
  const detectedProviders = detectProvidersFromEnv();
  const sdkVersion = readSdkVersion('@google/generative-ai');

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
      sdk: 'google',
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
      sdk: 'google',
      sdk_version: sdkVersion,
      attached: false,
      reason: 'local_server_bind_failed',
      providers_detected: [...detectedProviders],
    });
    return;
  }

  _serverPort = bound.port;

  // Hook Module._load so the FIRST require/import of @google/generative-ai
  // gets a patched module. Idempotent — multiple attach() calls (multi-PR
  // test fixtures, reload, etc.) install the hook only once.
  installLoadHook();

  await emitAttachEvent({
    sdk: 'google',
    sdk_version: sdkVersion,
    attached: true,
    bound_port: bound.port,
    fallback_port: bound.port !== 18790,
    primary_base_url: primaryBaseUrl ?? null,
    providers_detected: [...detectedProviders],
  });
}

function installLoadHook() {
  if (_patchInstalled) return;
  _patchInstalled = true;

  const origLoad = _NodeModule._load;
  _NodeModule._load = function (request, parent, isMain) {
    const exported = origLoad.apply(this, arguments);
    if (
      typeof request === 'string' &&
      (request === '@google/generative-ai' || request.startsWith('@google/generative-ai/'))
    ) {
      try {
        return patchGoogleModule(exported);
      } catch {
        return exported;
      }
    }
    return exported;
  };
}

/**
 * Mutate the SDK module so every `getGenerativeModel()` call returns a
 * model whose `requestOptions.baseUrl` defaults to our local server.
 * If the user explicitly passes a baseUrl, we leave it alone.
 */
function patchGoogleModule(mod) {
  const Klass = mod?.GoogleGenerativeAI;
  if (!Klass || Klass.__rr_patched) return mod;

  const proto = Klass.prototype;
  if (!proto || typeof proto.getGenerativeModel !== 'function') return mod;
  if (proto.getGenerativeModel.__rr_patched) return mod;

  const original = proto.getGenerativeModel;

  proto.getGenerativeModel = function patchedGetGenerativeModel(modelParams, requestOptions) {
    const ourBase = `http://127.0.0.1:${_serverPort}/google/v1beta`;
    const merged = {
      ...(requestOptions || {}),
      baseUrl: requestOptions?.baseUrl || ourBase,
    };
    return original.call(this, modelParams, merged);
  };

  proto.getGenerativeModel.__rr_patched = true;
  Klass.__rr_patched = true;
  return mod;
}

// Exported for tests — verify the hook detection without spawning a child
export function _patchModuleForTests(mod, port = 18790) {
  _serverPort = port;
  return patchGoogleModule(mod);
}
