/**
 * Singleton wrapper around `startLocalServer` for the Phase 4 multi-adapter
 * world. Each adapter (anthropic, openai, google) calls `attach()`, which
 * needs the local server bound exactly once per process. Without this
 * coordinator, the second adapter would attempt a second bind on the same
 * port and trip our fallback logic for no reason.
 *
 * The coordinator returns the SAME `{ port, server }` shape `startLocalServer`
 * itself returns. First caller wins; subsequent callers await the in-flight
 * promise and get the same result.
 */

let inflight = null;

export async function ensureLocalServerStarted({ starter }) {
  if (!inflight) {
    inflight = Promise.resolve()
      .then(starter)
      .catch((err) => {
        // Never poison the singleton — let next caller retry.
        inflight = null;
        throw err;
      });
  }
  return inflight;
}

// Test-only reset so unit suites can re-exercise the binding path without
// worker isolation. Production code never calls this.
export function _resetLocalServerSingletonForTests() {
  inflight = null;
}
