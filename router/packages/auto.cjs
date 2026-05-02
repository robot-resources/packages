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

// Set env vars EAGERLY (sync). The Anthropic + OpenAI SDKs read these on
// every constructor call; setting them now means user code that runs after
// auto.cjs picks up our localhost URL even before async server bind finishes.
//
// Anthropic: respects pre-existing user override.
// OpenAI:    same — never clobber a user-set OPENAI_BASE_URL.
//
// Google: no env-var override exists; the Google adapter monkey-patches the
// SDK at Module._load time instead.
//
// If the local server fails to bind (port in use + fallback also fails), the
// SDK gets ECONNREFUSED on first call — visibly broken, not silently broken.
const PRIMARY_ANTHROPIC = 'http://127.0.0.1:18790/anthropic';
const PRIMARY_OPENAI = 'http://127.0.0.1:18790/openai/v1';

if (!process.env.ANTHROPIC_BASE_URL) {
  process.env.ANTHROPIC_BASE_URL = PRIMARY_ANTHROPIC;
}
if (!process.env.OPENAI_BASE_URL) {
  process.env.OPENAI_BASE_URL = PRIMARY_OPENAI;
}

// Async kick. Dynamic imports work in CJS; the adapter modules are ESM.
// Errors are swallowed by default; set RR_AUTOATTACH_DEBUG=1 to see them.
//
// `RR_AUTOATTACH_DRY_RUN=1` skips actual server bind + telemetry — used
// by the test suite to assert pure env-var behavior without binding ports.
//
// All three adapters share the same in-process server via the singleton
// in `lib/adapters/_local-server-once.js`. Whichever adapter attaches
// first binds the port; the others reuse the result.
if (process.env.RR_AUTOATTACH_DRY_RUN !== '1') {
  Promise.allSettled([
    import('./lib/adapters/anthropic-node.js')
      .then((mod) => mod.attach({ primaryBaseUrl: PRIMARY_ANTHROPIC })),
    import('./lib/adapters/openai-node.js')
      .then((mod) => mod.attach({ primaryBaseUrl: PRIMARY_OPENAI })),
    import('./lib/adapters/google-node.js')
      .then((mod) => mod.attach({ primaryBaseUrl: null })),
  ]).then((results) => {
    if (process.env.RR_AUTOATTACH_DEBUG !== '1') return;
    for (const r of results) {
      if (r.status === 'rejected') {
        console.error('[robot-resources/auto] adapter attach failed:', r.reason?.message || r.reason);
      }
    }
  });
}
