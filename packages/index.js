/**
 * Robot Resources plugin for OpenClaw — shim entry point.
 *
 * Two integrations live in lib/plugin-core.js:
 *  1. before_model_resolve → route through Robot Resources Router (localhost:3838).
 *  2. before_tool_call → redirect web_fetch through the Scraper MCP.
 *
 * This file is deliberately thin. A broken release of plugin-core.js can crash
 * during module evaluation (top-level await below) or during register(); both
 * paths land in handleLoadFailure, which restores the previous .bak-* release
 * and arms a 24h skip window before re-raising so OpenClaw disables the
 * plugin gracefully for this session. The user's next OC session picks up the
 * rolled-back code.
 *
 * Install: openclaw plugins install @robot-resources/openclaw-plugin
 * Requires: Robot Resources Router running (npx robot-resources)
 */

let _coreModule = null;
let _loadError = null;

try {
  _coreModule = await import('./lib/plugin-core.js');
} catch (err) {
  _loadError = err;
  try {
    const { handleLoadFailure } = await import('./lib/safe-load.js');
    await handleLoadFailure(err);
  } catch { /* safe-load itself may be affected by the bad release */ }
}

const shim = {
  id: 'openclaw-plugin',
  name: 'Robot Resources',
  description: 'Cost-optimized model routing + token-compressed web fetching',

  register(api) {
    if (!_coreModule) {
      api?.logger?.warn?.(
        `[robot-resources] Plugin load failed — disabled for this session. ` +
        `Previous version restored; next OC session will use it. Error: ${_loadError?.message || _loadError}`,
      );
      throw _loadError || new Error('plugin-core failed to load');
    }

    try {
      return _coreModule.default.register(api);
    } catch (err) {
      // register() itself threw. Trigger rollback and re-raise.
      import('./lib/safe-load.js')
        .then(({ handleLoadFailure }) => handleLoadFailure(err))
        .catch(() => { /* swallow */ });
      throw err;
    }
  },
};

export default shim;

// Re-exports for tests and external callers. Undefined when plugin-core failed to load.
export const DEFAULT_ROUTER_URL = _coreModule?.DEFAULT_ROUTER_URL;
export const ROUTER_MODELS = _coreModule?.ROUTER_MODELS;
export const askRouter = _coreModule?.askRouter;
export const detectSubscriptionMode = _coreModule?.detectSubscriptionMode;
