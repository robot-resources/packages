# @robot-resources/router

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
