'use strict';

/**
 * Robot Resources auto-attach entry point.
 *
 * Loaded via `NODE_OPTIONS="--require @robot-resources/router/auto"`. Runs
 * before the user's code so it can intercept the agent's LLM SDK calls.
 *
 * Phase 1 scope:
 *   - Anthropic SDK only.
 *   - Behind `RR_AUTOATTACH=1` gate (the wizard does NOT yet write
 *     NODE_OPTIONS into shell config — that's Phase 3, after we prove the
 *     bundler-fixture matrix).
 *   - Mechanism: set `ANTHROPIC_BASE_URL` to a localhost URL and start an
 *     in-process routing server. The Anthropic SDK reads that env var in
 *     its constructor (verified against @anthropic-ai/sdk client.js line 50).
 *     No SDK monkey-patching needed.
 *
 * Lifecycle: the local server lives and dies with the agent's Node process.
 * Same pattern as the OC plugin — no daemon, no service registration.
 *
 * CJS extension is deliberate: `--require` only accepts CJS in Node 18.
 * ESM-only `--import` is Node 20.6+ which we don't yet require. The actual
 * adapter modules below are ESM and loaded via dynamic import.
 */

// Gate. Phase 1 ships opt-in until the bundler matrix proves out.
if (process.env.RR_AUTOATTACH !== '1') return;

// Singleton — auto.cjs may load multiple times in worker threads / IPC.
if (globalThis.__RR_AUTOATTACH_LOADED__) return;
globalThis.__RR_AUTOATTACH_LOADED__ = true;

// Respect a pre-existing user override. If they explicitly pointed the SDK
// somewhere (custom proxy, dev-stub, etc.), don't fight them.
if (process.env.ANTHROPIC_BASE_URL) return;

// Set the env var EAGERLY (sync). The SDK reads it on every `new Anthropic()`
// call. Server bind happens async via dynamic import below — the env var has
// to be in place before any user code runs, so we set it immediately and the
// async work catches up.
//
// If the local server fails to bind (port in use + fallback also fails), the
// SDK gets ECONNREFUSED on first call — visibly broken, not silently broken.
const PRIMARY_BASE_URL = 'http://127.0.0.1:18790/anthropic';
process.env.ANTHROPIC_BASE_URL = PRIMARY_BASE_URL;

// Async kick. Dynamic import works in CJS; the adapter module is ESM.
// Errors are swallowed by default; set RR_AUTOATTACH_DEBUG=1 to see them.
//
// `RR_AUTOATTACH_DRY_RUN=1` skips the actual server bind + telemetry — used
// by the test suite to assert pure env-var behavior without binding ports.
if (process.env.RR_AUTOATTACH_DRY_RUN !== '1') {
  import('./lib/adapters/anthropic-node.js')
    .then((mod) => mod.attach({ primaryBaseUrl: PRIMARY_BASE_URL }))
    .catch((err) => {
      if (process.env.RR_AUTOATTACH_DEBUG === '1') {
        console.error('[robot-resources/auto] adapter attach failed:', err?.message || err);
      }
    });
}
