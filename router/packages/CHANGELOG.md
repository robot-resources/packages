# @robot-resources/router

## 4.4.0

### Minor Changes

- 70159b0: feat(router,cli): standalone `npx @robot-resources/router` wizard (Phase 5)

  Adds a `bin` entry to `@robot-resources/router` so users who only want routing (no scraper) can run `npx @robot-resources/router` and get a smaller install. Backed by a new `--scope=router-only` flag in the unified wizard, which skips the scraper MCP registration step on the OC path.

  **The router bin** (`router/packages/router/bin/setup.js`) is a small spawn wrapper:

  ```
  npx --yes robot-resources --scope=router-only [user-args...]
  ```

  This delegates everything (signup, agent detection, shell-config writing, pip install) to the unified wizard via the new flag — zero duplication. Side benefit: any future wizard improvement automatically reaches both entry points.

  **Why spawn instead of import:** the dependency arrow is `robot-resources` → `@robot-resources/router`. Reversing it would create a workspace cycle. Spawning sidesteps that without bundling the wizard code into the router package.

  **The wizard's new `--scope` flag:**

  - `scope=full` (default) — current behavior. Installs router + scraper.
  - `scope=router-only` — skips the scraper MCP registration step in the OC branch. Non-OC paths are router-only by definition (Node shim + pip robot-resources both ship without scraper code), so they're untouched.

  Tagged on `wizard_started.scope` so the funnel can segment by entry CLI in Supabase.

  **Files:**

  - `packages/cli/lib/wizard.js` — adds `scope` param to `runWizard`. Skips Step 2 (scraper) when `scope=router-only`. Tags telemetry.
  - `packages/cli/bin/setup.js` — parses `--scope=...` arg.
  - `router/packages/router/bin/setup.js` — NEW. ~30 lines.
  - `router/packages/router/package.json` — adds `bin` entry + `bin/` to `files[]`.
  - `packages/cli/test/wizard.test.mjs` — 4 new tests (skips scraper / preserves default / payload tag / default-payload).

  **Test plan:**

  - 238/238 CLI tests pass.
  - Live verified: `node router/packages/router/bin/setup.js --uninstall` correctly delegates to `npx --yes robot-resources --scope=router-only --uninstall` (the spawn surface).

  **What's NOT in this PR:**

  - The router bin is unbundled; first run on a fresh machine fetches both `@robot-resources/router` and `robot-resources` via npx (npx caches both, so subsequent runs are fast).
  - We could later inline the wizard into the router package to skip the second fetch — defer until usage signals warrant it.

### Patch Changes

- 73664c1: feat(router,python): OpenAI + Google adapters in both languages (Phase 4)

  Mechanical extension of Phase 1's pattern. Same `RR_AUTOATTACH=1` gate;
  same in-process server; same telemetry.

  **Node — `@robot-resources/router`** (this changeset):

  - New `lib/adapters/openai-node.js` — env-var override of `OPENAI_BASE_URL`. The OpenAI SDK reads it natively (`openai/client.js:71`), same trick as Anthropic. `auto.cjs` sets it eagerly.
  - New `lib/adapters/google-node.js` — Google's SDK doesn't honor a base-URL env var, so we monkey-patch `GoogleGenerativeAI.prototype.getGenerativeModel` at `Module._load` time. The user's API key continues to flow through unchanged.
  - New `lib/adapters/_local-server-once.js` — singleton coordinator. All three adapters share one `startLocalServer` bind per process. Phase 1's anthropic adapter refactored to use it.
  - `auto.cjs` now sets BOTH `ANTHROPIC_BASE_URL` and `OPENAI_BASE_URL` eagerly + loads all three adapters in parallel via `Promise.allSettled` (one failing doesn't block the others).

  **Python — PyPI 0.3.0** (manual publish post-merge, mirrors Phase 2):

  - New `_autoattach/openai_patch.py` — wraps `openai.resources.chat.completions.Completions.create` (sync + async). Routes via `/v1/route` cloud endpoint, swaps `model` in kwargs.
  - New `_autoattach/google_patch.py` — wraps `google.generativeai.GenerativeModel.generate_content` (sync + async). Mutates `self.model_name` for the call duration so the SDK builds the right URL.
  - `_autoattach/__init__.py` now loads all three patchers, each isolated in its own try/except — one failing adapter doesn't disable the others.
  - pyproject.toml bumped to `0.3.0`.

  **Test coverage** (all green):

  - Router: 356 tests (15 new in `adapter-openai-google.test.mjs`; existing anthropic-node tests updated to reset the new singleton).
  - Python: 46 tests (14 new across `test_openai_patch.py` + `test_google_patch.py`).

  **Telemetry note:** `adapter_attached` events now also fire with `sdk: 'openai'` and `sdk: 'google'`. Same payload shape as Phase 1 — directly queryable in Supabase under the same `api_key_id` key.

  **What's NOT in this PR:**

  - `google.genai` (the new package; this targets the legacy `google-generativeai`).
  - Wizard messaging changes for OpenAI/Google detection (Phase 3 already detects them as Node SDKs; the per-call routing just works once auto-attach is wired).
  - Standalone router CLI (Phase 5).

  **Manual PyPI publish required after this merges:** `cd python/robot-resources && rm -rf dist && python3 -m build && python3 -m twine upload dist/*`. Mirrors the Phase 2 publish flow.

## 4.3.3

### Patch Changes

- d536cf2: feat(router): Node `--require` auto-attach entry for Anthropic SDK (Phase 1, opt-in)

  Phase 1 of the universal-installer refactor. Adds a `./auto` subpath export that, when loaded via `NODE_OPTIONS="--require @robot-resources/router/auto"`, auto-routes the agent's Anthropic SDK calls through Robot Resources.

  **Mechanism (no monkey-patching):** The Anthropic SDK constructor reads `ANTHROPIC_BASE_URL` directly (verified in `@anthropic-ai/sdk` `client.js:50`). `auto.cjs` sets that env var to `http://127.0.0.1:18790/anthropic` BEFORE user code runs and then starts an in-process routing server (reuses `lib/local-server.js` from the OC plugin path — already standalone). When the user creates `new Anthropic()`, every method routes through the local server: classifier picks the cheapest in-lab model → forwards to api.anthropic.com with the user's existing key. Same lifecycle as the OC plugin: lives and dies with the agent's process. No daemon, no service registration.

  **Opt-in gate:** The wizard does NOT yet write `NODE_OPTIONS` into shell config. Users explicitly enable Phase 1 via `RR_AUTOATTACH=1` until the bundler-fixture matrix proves the patch survives esbuild / Vite / ESM-only / pnpm setups. Phase 3 lifts this gate.

  **Safety properties:**

  - Singleton guard — multiple loads (worker threads, IPC) early-return.
  - Respects pre-existing `ANTHROPIC_BASE_URL` — never clobbers a user override.
  - Falls back to OS-chosen port + rewrites the env var if 18790 is taken (e.g. an OC plugin already running on the same machine).
  - Errors are swallowed by default; `RR_AUTOATTACH_DEBUG=1` surfaces them.
  - `RR_AUTOATTACH_DRY_RUN=1` skips the server bind for tests.

  **New telemetry:** `adapter_attached` — fired once per process at attach time. Payload: `{sdk, sdk_version, attached, bound_port, fallback_port, providers_detected, language: 'node', module_system: 'cjs'}`. Plus a `reason` field (`local_server_bind_failed` / `local_server_throw`) on failure. This is the first non-OC adoption signal in Supabase.

  **Files added:**

  - `auto.cjs` — the `--require` entry. CJS so it works with Node 18's `--require` (ESM-only `--import` is Node 20.6+).
  - `lib/adapters/_attach.js` — telemetry + provider-detection helpers.
  - `lib/adapters/anthropic-node.js` — `attach()` boots the local server + emits telemetry.
  - `package.json` — adds `"./auto": "./auto.cjs"` to `exports`, adds `auto.cjs` to `files[]`.

  **Tests:** 16 new (8 surface tests for the package export + spawn-child env-var assertions; 8 adapter unit tests covering primary-bind / fallback-bind / both failure modes / provider detection). 349/349 router tests pass.

## 4.3.2

### Patch Changes

- 18af7da: Restore two robustness behaviors from the v2.x python daemon that were lost across the in-process refactor (#173) and multi-lab dispatch (#196).

  **1. URL-semantics shape detection.** `detectProviderFromUrl` now recognizes bare lab-native URLs (`/v1/messages`, `/v1/responses`, `:generateContent`) in addition to the multi-shape prefix path (`/anthropic/...`). When OC dispatches via `provider.baseUrl` (no shape prefix) instead of `model.baseUrl` (prefixed), the router still recognizes the shape from the URL alone. `buildUpstreamUrl` correspondingly handles bare URLs without requiring the prefix to strip.

  **2. Request-header keys take priority.** `resolveProviderKey` now reads from request headers (`x-api-key`, `Authorization: Bearer`, `x-goog-api-key`) before falling back to stored OC config / auth-profile files / env vars. Per-request, never cached. Whatever key OC sends in the request is the key forwarded upstream — robust against `openclaw.json` drift.

  Together these restore the v2.x design principle: derive shape + key from the request itself, not from configuration that can drift. Verified live on the openclaw test droplet via Telegram (4 successful round-trip prompts, 2.6-2.8s latency).

## 4.3.1

### Patch Changes

- 15e0cea: Fix two production-broken signals discovered during 2026-05-01 fleet diagnostic:

  **Platform — classifier model.** `gemini-1.5-flash-8b` was deprecated and shut down by Google in 2026-Q2; every `/v1/route` call to the slow path AND every router-side classify call returned HTTP 404, which our catch-all telemetry mislabeled as `network_error`. Every install in the fleet was falling back to keyword routing on every prompt. Switched to `gemini-2.5-flash-lite` — same flavor (smallest/cheapest/fastest), works with the existing free-tier `CLASSIFIER_GOOGLE_API_KEY`, verified live from the openclaw droplet (HTTP 200 vs 404 on the dead model).

  **Router — recurring heartbeat.** `plugin_register` fired exactly once per OC process with no retry; a single bad fetch at boot (network blip / transient platform 5xx / DNS hiccup before networking was ready) stranded the install as a silent fleet member until the next OC restart. Added a 15-min recurring `router_heartbeat` (same shape and cadence as the retired python `router_heartbeat`) so one missed tick is recovered on the next.

## 4.3.0

### Minor Changes

- 04e95b1: Multi-lab dispatch in plugin: route requests to Anthropic, OpenAI, and Google upstream APIs based on the configured provider, instead of forwarding everything to api.anthropic.com. Includes agent-runtime integration test (PR #196).

## 4.2.0

### Minor Changes

- e1d5c56: feat: expose routing as a public JS library — `import { routePrompt, asyncRoutePrompt } from '@robot-resources/router/routing'` for non-OC JS/TS agents (LangChain, LangGraph, Mastra, etc.). Also exposes `./telemetry` for opt-in `route_via_lib` event posting. Zero new dependencies; the routing module never reads user provider keys (caller passes `modelsDb`), so it's safe to use outside the OC plugin context.

## 4.1.1

### Patch Changes

- 37e0d85: PR 6 of the in-process refactor: split the scraper hook out of the router plugin into its own OC plugin package.

  The router plugin previously carried both the in-process model-routing logic AND a small `before_tool_call` hook that redirects OpenClaw's `web_fetch` tool calls to `scraper_compress_url` (provided by `@robot-resources/scraper-mcp`). PR 6 splits these — model routing stays in `@robot-resources/router`, and the scraper redirect hook moves to a brand-new `@robot-resources/scraper-oc-plugin` package. One tool per OC plugin.

  What changes for users:

  - **Fresh installs** of `npx robot-resources` now create `~/.openclaw/extensions/robot-resources-scraper-oc-plugin/` alongside `~/.openclaw/extensions/robot-resources-router/`, and register both in `openclaw.json` (`plugins.entries` + `plugins.allow`).
  - **Returning users**: re-running `npx robot-resources` adds the second plugin entry to your config. Old `openclaw-plugin/` orphans (from pre-PR-5) stay harmless.
  - **Behavior is unchanged**: `web_fetch` still gets redirected to `scraper_compress_url`, just from a different OC plugin process now.

  What this PR explicitly does NOT change:

  - Scraper MCP server (`@robot-resources/scraper-mcp`) — untouched. Still serves non-OC consumers (Cursor, Aider, Claude Code).
  - Scraper core lib (`@robot-resources/scraper`) — untouched.
  - Router routing decisions — the router plugin's in-process server still owns model selection.

  Originally scoped as deferred indefinitely at PR 5 planning time (the hook is only ~20 LOC with zero scraper-lib dependencies, and there was no current non-OC consumer to justify a new package). Manuel's call 2026-04-27 to do it now anyway, ahead of PR 8's multi-agent compatibility work.

  Out-of-band post-merge: verify `@robot-resources/scraper-oc-plugin@0.1.0` actually publishes via the OIDC pipeline. First-time publish of a new package may need a manual one-shot.

## 4.1.0

### Minor Changes

- 6107fc5: PR 5 of the in-process refactor: rename the OC-side plugin id `openclaw-plugin` → `robot-resources-router`.

  PR 2.5 renamed the npm package and moved the source folder, but the OC plugin id (the string OC uses to key the plugin in `~/.openclaw/openclaw.json`) was left as the legacy `openclaw-plugin`. PR 5 closes that gap so the npm package, the source folder, the dashboard, and the user's OC config all use the same name.

  What changes for users:

  - **Fresh installs** of `npx robot-resources` now create `~/.openclaw/extensions/robot-resources-router/` and write `plugins.entries['robot-resources-router'] = { enabled: true }` + `plugins.allow` includes `'robot-resources-router'`.
  - **Returning users** (anyone with a working PR 2.5+ install): re-running `npx robot-resources` writes the new entry. The old `~/.openclaw/extensions/openclaw-plugin/` directory + `plugins.entries.openclaw-plugin` entry stay orphaned on disk — harmless (OC logs and skips a plugin entry pointing at a missing directory).
  - **`detect.js`'s OR-check is preserved** as a soft-migration helper; drop in a follow-up after telemetry shows zero installs use the legacy path.

  What's NOT in this PR (originally scoped, dropped during planning):

  - The strategy doc originally bundled this rename with a "scraper hook split" — moving the `before_tool_call` hook (`web_fetch` → `scraper_compress_url`) into its own OC plugin under the scraper workspace. Phase 1 exploration killed that bundle: the hook is a 20-line tool-rewrite with zero `@robot-resources/scraper` imports, splitting it adds a 5th workspace package + new publish for ~20 LOC with no current user case. Hook stays in the router plugin; revisit when PR 7 surfaces non-OC scraper consumers.

  Files flipped (source): `router/packages/router/{openclaw.plugin.json,index.js,lib/plugin-core.js}`, `packages/cli/lib/{tool-config.js,wizard.js,health-report.js}`. Tests: `router/packages/router/test/{plugin,openclaw-harness,self-update}.test.mjs`, `packages/cli/test/{tool-config,health-report,detect}.test.mjs`. Total: ~30 string literals + 1 surgical test-label swap.

## 4.0.2

### Patch Changes

- a8f2b7d: PR 4a of the in-process refactor: revive the auto-update loop.

  PR 2.5's npm package rename (`@robot-resources/openclaw-plugin` → `@robot-resources/router`) swept the install-time consumers but missed two runtime ones:

  - `lib/self-update.js` validated downloaded tarballs against the old name → every real update would have been rejected as `wrong_package`.
  - `platform/v1/version` (the dashboard + plugin update endpoint) polled the old npm name, which is frozen at 0.6.0 → every running plugin polling daily was told "latest = 0.6.0", and the dashboard plugin-version KPI was pinned there.

  Net effect since PR 2.5: every shipped 4.x plugin's daily auto-update was silently dead. Plugins kept routing fine because the in-process server is unrelated to update polling, but no version after the one a user installed could ever reach them automatically.

  This PR flips both string literals to `@robot-resources/router`, updates the corresponding test fixtures (`platform/.../version.test.ts` ×6 and `router/.../self-update.test.mjs` ×4), and stays within the package-name namespace. The OC plugin id (`openclaw-plugin` in users' `openclaw.json`) is unchanged — that rename is bundled into PR 5 with the scraper hook split.

  Out-of-band after this release publishes:

  - `npm deprecate @robot-resources/openclaw-plugin@'*' "Replaced by @robot-resources/router. Re-run npx robot-resources to migrate."`

## 4.0.1

### Patch Changes

- PR 3 internal cleanup. No behavior change vs 4.0.0 in the published files (`index.js`, `openclaw.plugin.json`, `lib/`). The repo around the package was significantly trimmed (Python source, Docker scaffolding, `@robot-resources/router-mcp` package, CI Python jobs all deleted) but none of that ships in this tarball.

  Note on numbering: PR 2.5's release published `@robot-resources/router@4.0.0` and `4.0.0` got unpublished within npm's window. `4.0.1` is the resumed line from PR 3 onward.

## 4.0.0

### Major Changes

- 5876289: PR 2.5: in-process HTTP server replaces the dead `localhost:3838` daemon
  path AND consolidates the JS code into the router tool's home folder.

  What shipped:

  - **Router source moved** from `packages/openclaw-plugin/` (the wrong place
    — the OC plugin was always router-specific functionality, not a separate
    product) into `router/packages/router/` (the router tool's npm package
    home, mirroring `scraper/packages/{scraper,scraper-mcp,...}`). The npm
    package `@robot-resources/router` jumps 2.3.6 → 3.0.0; its v2.x shape
    was a Python-CLI wrapper that no longer exists.

  - **OC plugin (`openclaw-plugin` id, install path
    `~/.openclaw/extensions/openclaw-plugin/`) is unchanged from a user's
    perspective** — only the npm distribution shifted. `npx robot-resources`
    now installs `@robot-resources/router` instead of
    `@robot-resources/openclaw-plugin` (deprecated).

  - **In-process HTTP server**: plugin starts a node http server on
    `127.0.0.1:18790` at register time. OC's standard provider catalog
    dispatch sends LLM calls there; the handler runs the JS classifier on the
    user prompt, picks an Anthropic model, fetches api.anthropic.com directly
    with the user's existing key, and pipes the SSE response back unchanged.

  - **Daemon-install code DELETED** from the unified CLI:
    `packages/cli/lib/{service.js, python-bridge.js}` (740 + 38 LOC),
    `packages/cli-core/{python-bridge.mjs, uv-bootstrap.mjs}` (272 + 336 LOC),

    - dead Python install / service registration / health probe branches in
      `packages/cli/lib/wizard.js` (~150 LOC stripped). The wizard now does
      exactly four things: provision api_key → install OC plugin → register
      scraper MCP → restart OC. No Python, no venv, no systemd, no port probe.

  - **`packages/openclaw-plugin/` DELETED** entirely (moved to new home).
    Last published as `@robot-resources/openclaw-plugin@0.6.0`; that package
    is dead going forward — npm consumers should depend on
    `@robot-resources/router@^3` instead.

  - **`lib/plugin-heal.js` DELETED** — daemon-revive code, no daemon to heal.

  Verified end-to-end on the test droplet 2026-04-26: real Telegram messages
  routed correctly, `route_completed mode=in-process` events in Supabase, no
  errors. Plugin source at the new location works identically to the
  pre-restructure version.

  Why the architecture pivot (long version in
  business/refactor-router-in-process.md):

  PR 2's plugin-SDK hook approach was dead in OC 2026.4.24's agent runtime —
  neither `before_model_resolve` nor `before_agent_start` nor `wrapStreamFn`
  fire from the path 100% of users (Telegram→agent) take. PR 2 also had a
  silent sync-register failure that silently rolled back hook commits. Option
  4 keeps OC's standard catalog-dispatch wire shape but collapses what was
  the Python daemon into the plugin's own node process.

  Stranded users on plugin 0.6.0 have to reinstall via `npx robot-resources`
  to pick up the fix.

## 2.3.6

### Patch Changes

- 4c9590e: Stamp `cli_version` on every CLI telemetry payload (`wizard_started`,
  `install_complete`). Without this, npx-cached old installers look identical
  to fresh runs in Supabase — exactly the visibility gap that left us blind
  on real-user install failures despite shipping rich diagnostics in PR #163.

  Today's RU signups emitted the most-primitive 4-field `install_complete`
  payload (no `routerError`, no `platform`, no `python_source`) — proving
  they ran a pre-1.9 cached CLI even though 1.9.6 is on npm. The
  `cli_version` field lets us segment by version in the dashboard and
  finally know which cohort a failure came from.

  Pure additive — the platform telemetry endpoint preserves payload verbatim,
  so the field flows straight to Supabase without server changes.

## 2.3.5

### Patch Changes

- ffa5a26: Fix: two install failures surfaced by today's telemetry are now handled.

  **1. `tiktoken` wheel-build failures (2 RU users, `wheel_build_failed`).** The `tiktoken` Python package needs either a pre-built wheel OR a Rust compiler to build from source. When neither is available (unusual Python/OS/arch combos), pip install fails completely.

  Fix: `tiktoken` moved from required `dependencies` to the `[tokenizer]` extra in `robot-resources-router`. The router's tokenizer module already has a runtime fallback to `len(text) // 4` when tiktoken is unavailable. CLI wizards now do a two-step install — try `robot-resources-router[tokenizer]` first, fall back to the bare install on wheel-build failure. Routing still works either way; only exact BPE token counts become approximate.

  **2. `python3-venv` module missing (1 DE user, previously classified `unknown`).** Debian/Ubuntu ships `python3` without the `venv` module — it's a separate apt package. `findOrInstallPython()` now detects this case and falls back to uv-managed Python (which has venv built in) instead of throwing the old "apt install python3-venv" error.

  **Also:**

  - New error classifier reasons: `python_venv_missing`, `wheel_build_failed`
  - Classifier now inspects stderr (not just the exception message) so failures that leave the reason text in the pip subprocess output get categorized correctly
  - No behavior change when everything works — only affects failure paths

- Updated dependencies [ffa5a26]
  - @robot-resources/cli-core@0.1.6

## 2.3.4

### Patch Changes

- 3587f10: Feat: install now works on machines without Python. When `findPython()` returns nothing (most common install failure — `routerError: python_not_found` is ~67% of real failures in recent telemetry), the wizard now bootstraps `uv` (Astral's Python installer) and uses it to install a managed Python 3.11 into uv's cache. Everything still lives under `~/.robot-resources/` — no sudo, no system modifications, nothing that can break OpenClaw or other tools on the user's machine.

  Flow when system Python is absent:

  1. Download the pinned uv binary (~15MB) for the user's platform from `github.com/astral-sh/uv/releases` → SHA256-verified → extracted into `~/.robot-resources/bin/uv`
  2. `uv python install 3.11` → installs standalone Python into uv's managed cache
  3. `uv python find 3.11` → returns the path to that Python
  4. Normal `ensureVenv()` / `installRouter()` continues with that Python

  Supported platforms (uv release targets): macOS x64/arm64, Linux x64/arm64 (glibc), Windows x64/arm64.

  Install_complete telemetry payload now includes `pythonSource` = `'system' | 'uv' | 'existing-venv'` so we can measure how many installs the fallback rescues.

  If uv bootstrap fails (no network, unsupported platform, etc.), the wizard falls back to the existing "Python 3.10+ not found" error — no regression vs today.

- Updated dependencies [3587f10]
  - @robot-resources/cli-core@0.1.5

## 2.3.3

### Patch Changes

- a00c504: Feat: `install_complete` telemetry now includes the actual reason when router installation fails.

  Before: if pip install failed, we'd log `router: false` and discard stderr. 6 real users today all showed `router: false` with zero diagnostic data — we couldn't tell python-not-found from network-error from permission-denied.

  Now: `install_complete` payload includes three extra fields whenever router install fails:

  - `routerError`: short enum — `python_not_found` | `spawn_enoent` | `timeout` | `pip_install_failed` | `permission_denied` | `disk_full` | `network` | `unknown`
  - `routerErrorDetail`: trailing 500 chars of pip stderr (bounded so we stay under the 10KB payload cap)
  - `platform`: `process.platform` (darwin / linux / win32)

  Also: `cli-core/python-bridge.mjs`'s `installRouter()` now actually captures stderr/stdout from the pip subprocess instead of piping them to /dev/null. The resulting error message tells you what pip actually printed, so even interactive users get useful debugging info when things fail.

  This is pure instrumentation — no behavioral change beyond "errors are now informative." Applies to both the unified wizard (`npx robot-resources`) and the standalone router CLI (`npx @robot-resources/router`).

## 2.3.2

### Patch Changes

- d2b126c: Feat: router-side self-healing on every startup. Closes the gap between one-shot CLI installs and existing users who got an incomplete install.

  On every `rr-router start`, a background task now:

  1. **Ensures persistent service registration.** Checks if the router is registered as launchd/systemd-user/crontab/schtasks — if not, registers itself. Idempotent: no-op when already registered. We do NOT start the service (we're already running) — just persist for next reboot.

  2. **Auto-updates the router from PyPI.** If an outdated version is installed, `pip install --upgrade robot-resources-router`. Throttled to once per 24h. Takes effect on next restart.

  3. **Auto-updates the OpenClaw plugin from npm.** If the plugin is installed locally and outdated, downloads the npm tarball (with SHA-1 verification), extracts, and swaps files in place with a `.bak-{version}` rollback. Rescues users stranded on broken plugin versions (0.5.5–0.5.7 top-level-await bug) whose plugin's own self-update couldn't fire because the plugin never loaded.

  4. **Emits `self_healed` telemetry events** so we can observe this working in production.

  Safety invariants: never blocks startup, never raises, all heal actions are idempotent and throttled. Works alongside the CLI wizard's first-time install path — this is the ongoing-maintenance surface.

  Respects `RR_TELEMETRY=off` for both the pip and plugin update paths (no outbound network requests from self-heal when telemetry is disabled).

## 2.3.1

### Patch Changes

- 1f3dc0c: Fix: every `npx @robot-resources/router` install has reported `router: false` in telemetry (100% failure rate, 3/3 real users since April 14) because `router/packages/router/lib/python-bridge.js:41` called `installRouter({ stdio: 'inherit' })` without awaiting the returned Promise. The pip install was fired and abandoned; the function returned the venvPython path before pip finished. Also, `{ stdio: 'inherit' }` was an invalid option — the underlying helper in `cli-core` only accepts `{ timeout }`.

  Fix: `await installRouter()` with no args, matching the unified wizard path in `packages/cli/lib/python-bridge.js` which has always worked correctly.

## 2.3.0

### Minor Changes

- cb8f10f: Windows support for router service registration via Task Scheduler.

  The wizard now registers `RobotResourcesRouter` as a user-scoped scheduled task triggered on logon, with a generated `.cmd` wrapper at `~/.robot-resources/rr-router-run.cmd` that sources `~/.robot-resources/router.env` and launches the venv python against `robot_resources.cli.main start`. No admin required.

  `installService()` / `isServiceRunning()` / `isServiceInstalled()` / `uninstallService()` all branch to a `schtasks.exe` implementation on `process.platform === 'win32'` — joining the same lifecycle as launchd (macOS) and systemd (Linux). `isServiceRunning()` uses the locale-independent `0x41301` (TASK_RUNNING) HRESULT from `schtasks /query /fo LIST /v`, not the localized Status column. Uninstall stops the running task (`schtasks /end`), removes the definition (`schtasks /delete /f`), and unlinks the wrapper; the env file is preserved to match Linux/macOS.

  Both wizards (unified CLI + standalone router) previously short-circuited on Windows with "automatic service not supported." That branch is removed — Windows now flows through the normal `installService(getVenvPythonPath())` path.

  Existing Windows installs that completed the wizard before this release can re-run `npx robot-resources` to pick up the scheduled task.

### Patch Changes

- Updated dependencies [0814ae7]
  - @robot-resources/openclaw-plugin@0.5.9

## 2.2.4

### Patch Changes

- 67b646a: Fix: restore router telemetry delivery — zero router events since April 5 after PR #108 replaced the working direct POST with a JSONL buffer + background sync that dies with the router process.

  - **Router `telemetry.py`**: `areport_safe()` now posts directly to `/v1/telemetry` (the proven pre-PR#108 path) and only buffers to JSONL on failure. Immediate delivery in the common case, resilience on transient outages.
  - **Router `sync.py`**: `_post_batch()` now treats only 2xx as success (previously counted 4xx like 401/400 as success, silently advancing the buffer offset and permanently losing events). Adds structured logging of HTTP status + body on failure. Adds `RR_API_KEY` env var fallback so enterprise agents with env-var auth get a working sync task.
  - **Plugin `buffer-flush.js`** (new): on plugin load, drains `~/.robot-resources/analytics/router-events.jsonl` and POSTs pending events to the platform — guarantees delivery even if the router process died before its own sync ran. Wired into `plugin-core.js` alongside the heartbeat and update check, same fire-and-forget pattern.

  After any agent re-runs the wizard (or self-updates the plugin to 0.5.7+), router telemetry should resume flowing within seconds of the next routing decision.

- Updated dependencies [67b646a]
  - @robot-resources/openclaw-plugin@0.5.7

## 2.2.3

### Patch Changes

- 6eedd3a: Fix: installPluginFiles now copies the plugin's `lib/` directory, not just the three top-level files. Since plugin 0.5.5 the shim in `index.js` imports `./lib/plugin-core.js` and friends — without this, every fresh install produces a plugin directory with an `index.js` that fails to load with `MODULE_NOT_FOUND`, emits zero telemetry, and can't self-update (the update mechanism lives in the missing `lib/update-check.js`). Confirmed on a live droplet: `~/.openclaw/extensions/openclaw-plugin/lib/` was empty after `npx robot-resources` on a fresh 0.5.6 install, causing silent plugin failure.

  Any agent that installed 0.5.5 or 0.5.6 before this CLI release needs to re-run the wizard once to pick up the fix. After that, the plugin's own self-update path handles future releases.

## 2.2.2

### Patch Changes

- e5f5e8c: Add OpenClaw detection to the standalone router wizard. Previously `npx @robot-resources/router` only configured Claude Code and Cursor — OpenClaw agents installing via this path wouldn't get the routing plugin. Now both install paths (`npx robot-resources` and `npx @robot-resources/router`) produce the same result for OpenClaw users.

## 2.2.1

### Patch Changes

- **Fix wrong SDK base_url instructions** printed by `printManualInstructions()`. Previous output set `ANTHROPIC_BASE_URL=http://localhost:3838/v1` — but the Anthropic SDK appends `/v1/messages` itself, producing `/v1/v1/messages` → 404. Corrected to `http://localhost:3838` (no `/v1`). Also removed the misleading `GOOGLE_API_BASE` line (env var doesn't exist; router has no native Google endpoints — route Gemini through the OpenAI-compatible client). Verified empirically against the running router.
- Enterprise onboarding: `RR_API_KEY` environment variable now skips the signup step in the wizard. An IT admin can pre-provision keys via `POST /v1/keys` in the dashboard, set `RR_API_KEY=rr_live_...` on each agent machine, and the wizard will pick it up directly. Bypasses the signup rate limit and avoids one claim URL per agent.
- Funnel telemetry parity with the unified CLI: standalone wizard now fires `wizard_started` (before Python install) and `install_complete` (at the end, with retry) to `/v1/telemetry`. Payloads distinguish the standalone path via `payload.source == 'rr-router'`.

## 2.2.0

### Minor Changes

- Standalone wizard for enterprise-grade setup: first-run flow now installs the Python router engine, registers it as a system service (launchd on macOS, systemd on Linux), and auto-configures detected AI tools (Claude Code, Cursor) as MCP clients. When no tools are detected, prints copy-pasteable SDK base_url instructions (`OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, `GOOGLE_API_BASE`). Docker installs skip service registration and show Dockerfile CMD, Compose sidecar, and background process options. Subsequent `rr-router` invocations skip the wizard; use `--setup` to re-run. Fixes a latent import bug where `bin/rr-router.js` referenced a missing `lib/first-run.js`.

## 2.1.6

### Patch Changes

- cedd4ea: fix: repository URLs point to public repo, consistent homepages, clean README

  All 7 packages now reference github.com/robot-resources/packages (public).
  README rewritten: zero monorepo internals, agent compatibility table, no broken links.
  openclaw-plugin homepage added. scraper/scraper-mcp homepage normalized.

- Updated dependencies [cedd4ea]
  - @robot-resources/cli-core@0.1.4

## 2.1.5

### Patch Changes

- 7f944e8: Add install_complete telemetry ping to CLI wizard and router first-run setup
