# robot-resources

## 1.10.5

### Patch Changes

- 4ff0155: Consolidate scraper packages: fold `@robot-resources/scraper-oc-plugin` and remove redundant `@robot-resources/scraper-mcp` workspace.

  Manuel's directive 2026-04-27: keep only **router, scraper, cli** packages — nothing else.

  What changed:

  - **`@robot-resources/scraper-oc-plugin@0.1.0` (yesterday's first-publish) is now folded into `@robot-resources/scraper`** as a `./oc-plugin` subfolder. The published 0.1.0 stays on npm forever for backwards compat (plus deprecate notice), but new installs pull the OC plugin from inside the scraper tarball at `<scraper>/oc-plugin/`. The CLI's `installScraperOcPluginFiles()` now resolves `@robot-resources/scraper/package.json` and copies the `oc-plugin/` subfolder into `~/.openclaw/extensions/robot-resources-scraper-oc-plugin/`. The OC plugin id and install destination are unchanged — the only difference is the npm-package source.

  - **`@robot-resources/scraper-mcp` workspace package deleted**. It was a thin wrapper that re-exposed scraper's MCP server via an `npm install` step. The wizard already used scraper's built-in `scraper-mcp` bin (`npx -y -p @robot-resources/scraper scraper-mcp`), so the standalone package was redundant for any wizard-installed user. The published v0.1.3 stays on npm + gets deprecated for any external consumers.

  - **`scraper-oc-plugin` and `scraper-mcp` removed from publish.yml** + root workspaces array. Future scraper releases publish a single npm package containing core + MCP server + OC plugin.

  What's NOT in scope (deferred):

  - `@robot-resources/scraper-tracking` (separate workspace, separate npm package). Folding it requires tsup config + new `./tracking` export + test migration. Will be a follow-up PR. After that, we hit Manuel's "router, scraper, cli, nothing else" target exactly. `api` doesn't count — it's a Cloudflare Workers deploy, not on npm.

  Out-of-band post-publish:

  - `npm deprecate @robot-resources/scraper-oc-plugin@'*' "Folded into @robot-resources/scraper. Run npx robot-resources to migrate."` (manual, since the package was just published yesterday)
  - `npm deprecate @robot-resources/scraper-mcp@'*' "Use @robot-resources/scraper's built-in scraper-mcp bin: npx -y -p @robot-resources/scraper scraper-mcp"` (or just leave deprecated as-is; existing 0.1.3 keeps working)

- Updated dependencies [4ff0155]
  - @robot-resources/scraper@0.4.0

## 1.10.4

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

- Updated dependencies [37e0d85]
  - @robot-resources/scraper-oc-plugin@0.2.0
  - @robot-resources/router@4.1.1

## 1.10.3

### Patch Changes

- 6107fc5: PR 5 of the in-process refactor: rename the OC-side plugin id `openclaw-plugin` → `robot-resources-router`.

  PR 2.5 renamed the npm package and moved the source folder, but the OC plugin id (the string OC uses to key the plugin in `~/.openclaw/openclaw.json`) was left as the legacy `openclaw-plugin`. PR 5 closes that gap so the npm package, the source folder, the dashboard, and the user's OC config all use the same name.

  What changes for users:

  - **Fresh installs** of `npx robot-resources` now create `~/.openclaw/extensions/robot-resources-router/` and write `plugins.entries['robot-resources-router'] = { enabled: true }` + `plugins.allow` includes `'robot-resources-router'`.
  - **Returning users** (anyone with a working PR 2.5+ install): re-running `npx robot-resources` writes the new entry. The old `~/.openclaw/extensions/openclaw-plugin/` directory + `plugins.entries.openclaw-plugin` entry stay orphaned on disk — harmless (OC logs and skips a plugin entry pointing at a missing directory).
  - **`detect.js`'s OR-check is preserved** as a soft-migration helper; drop in a follow-up after telemetry shows zero installs use the legacy path.

  What's NOT in this PR (originally scoped, dropped during planning):

  - The strategy doc originally bundled this rename with a "scraper hook split" — moving the `before_tool_call` hook (`web_fetch` → `scraper_compress_url`) into its own OC plugin under the scraper workspace. Phase 1 exploration killed that bundle: the hook is a 20-line tool-rewrite with zero `@robot-resources/scraper` imports, splitting it adds a 5th workspace package + new publish for ~20 LOC with no current user case. Hook stays in the router plugin; revisit when PR 7 surfaces non-OC scraper consumers.

  Files flipped (source): `router/packages/router/{openclaw.plugin.json,index.js,lib/plugin-core.js}`, `packages/cli/lib/{tool-config.js,wizard.js,health-report.js}`. Tests: `router/packages/router/test/{plugin,openclaw-harness,self-update}.test.mjs`, `packages/cli/test/{tool-config,health-report,detect}.test.mjs`. Total: ~30 string literals + 1 surgical test-label swap.

- Updated dependencies [6107fc5]
  - @robot-resources/router@4.1.0

## 1.10.2

### Patch Changes

- Republish of 1.10.1's contents under a fresh version. 1.10.0 and 1.10.1 were both unpublished from npm during a recovery operation around `@robot-resources/router@4.0.1` — both version numbers are now permanently tombstoned. 1.10.2 ships identical code to what 1.10.1 was supposed to be: PR 3 of the in-process refactor (wizard non-OC early-exit + Python daemon source deletion).

## 1.10.1

### Patch Changes

- 4c09ba4: PR 3 of the in-process refactor: delete the Python daemon source and surrounding scaffolding.

  What changed for users:

  - **Wizard non-OC early-exit guard.** Running `npx robot-resources` interactively on a machine without OpenClaw now prints a redirect message and exits cleanly. Zero filesystem writes, zero telemetry, no half-finished install. CI / agent / scripted callers that pass `nonInteractive: true` (or pre-set `RR_API_KEY`) bypass the guard — they explicitly chose to run.
  - **Scrubbed `@robot-resources/router-mcp` from advertised docs.** The package is being deprecated; `packages/cli/README.md` no longer suggests it.

  What changed in the repo (not user-facing, no behavior impact on `@robot-resources/router` itself):

  - `router/src/`, `router/tests/`, `router/{Dockerfile*, docker-compose.yml, scripts/, docs/, _legacy/, pyproject.toml}` deleted — every Python file is gone.
  - `router/packages/router-mcp/` deleted entirely. Its tools all hit `localhost:3838` (the dead Python daemon); every call has been broken in production since PR 2.5. The package will be `npm deprecate`d after this release publishes. PR 7 will rebuild a real MCP server tied to the public `/v1/route` endpoint.
  - `.github/workflows/publish-router-image.yml` deleted (Docker image push); Python jobs (`router-lint`, `router-typecheck`, `router-test`) and the PyPI publish branch deleted from `ci.yml` + `publish.yml`.
  - `.github/workflows/update-pricing.yml`: swapped Python (`pip install + rr-router update-pricing`) for Node (`node router/packages/router/scripts/update-pricing.mjs`). The new ~150-LOC script keeps the same contract — fetch litellm, update cost + max_tokens + last_updated, never touch capabilities — and emits the same stdout signals (`no changes` / `new_models` / `deprecated_models`) the workflow already greps for.

  Out-of-band after this release publishes:

  - Build a `robot-resources-router==2.99.0` redirect stub on a throwaway branch (~10 LOC), `twine upload`, yank prior PyPI versions. `pip install robot-resources-router` will then return a stub that prints "moved to npm" instead of the old daemon.
  - `npm deprecate @robot-resources/router-mcp@'*' "Replaced by in-process router. New MCP server lands in PR 7."`

## 1.10.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [5876289]
  - @robot-resources/router@4.0.0
  - @robot-resources/cli-core@0.1.8

## 1.9.7

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

## 1.9.6

### Patch Changes

- 5a998c8: Four coordinated fixes so the router actually survives past the wizard:

  - **CLI (service.js):** systemd-user install now verifies `loginctl enable-linger` actually took effect (the Finland signup on 2026-04-23 proved the silent-failure case is real) and installs a `crontab @reboot` belt alongside the user unit so the router comes back after reboot even when linger is denied by polkit.
  - **Plugin (plugin-heal.js):** new parallel healer runs on every OpenClaw gateway start. Pings `/health`, and if the router is dead it runs enable-linger, tries `systemctl --user restart`, falls back to a detached spawn, and polls until healthy. Acquires a PID-based lock (`~/.robot-resources/.heal.lock`) to avoid racing the router's own self_heal. Throttled to once per hour via a separate marker. Plugin now rescues users whose router died post-install — the router's own self_heal can't reach them.
  - **Worker + plugin (response channel):** the telemetry POST response now optionally carries `heal_hints` — a strict allowlist (`reheal_router` | `rerun_wizard`). Server decides based on the current event batch; plugin maps recognized hints to local actions (force-run the heal bypassing the throttle; surface a nag asking the user to re-run `npx robot-resources`). No arbitrary commands. Plugin silently drops anything outside the allowlist.
  - **Install_complete payload:** adds `linger_enabled` and `crontab_fallback` so we can tell which systemd-user installs are live-forever setups vs dying-on-logout.

- Updated dependencies [5a998c8]
  - @robot-resources/openclaw-plugin@0.5.12

## 1.9.5

### Patch Changes

- 8f0c760: Instrument install_complete with full diagnostics and stop reporting router=true for installs where the router doesn't actually answer /health. The success path now carries `platform`, `os_release`, `node_version`, `install_duration_ms`, `service_type`, `plugin_installed`, `openclaw_detected`, `openclaw_config_patched`, `scraper_mcp_registered`, and a full `health_check` object with pass/fail + latency. If /health won't respond after 3 retries, install_complete now reports `router=false` with `routerError='health_check_failed'` instead of silently claiming success.

## 1.9.4

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

## 1.9.3

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

## 1.9.2

### Patch Changes

- a00c504: Feat: `install_complete` telemetry now includes the actual reason when router installation fails.

  Before: if pip install failed, we'd log `router: false` and discard stderr. 6 real users today all showed `router: false` with zero diagnostic data — we couldn't tell python-not-found from network-error from permission-denied.

  Now: `install_complete` payload includes three extra fields whenever router install fails:

  - `routerError`: short enum — `python_not_found` | `spawn_enoent` | `timeout` | `pip_install_failed` | `permission_denied` | `disk_full` | `network` | `unknown`
  - `routerErrorDetail`: trailing 500 chars of pip stderr (bounded so we stay under the 10KB payload cap)
  - `platform`: `process.platform` (darwin / linux / win32)

  Also: `cli-core/python-bridge.mjs`'s `installRouter()` now actually captures stderr/stdout from the pip subprocess instead of piping them to /dev/null. The resulting error message tells you what pip actually printed, so even interactive users get useful debugging info when things fail.

  This is pure instrumentation — no behavioral change beyond "errors are now informative." Applies to both the unified wizard (`npx robot-resources`) and the standalone router CLI (`npx @robot-resources/router`).

## 1.9.1

### Patch Changes

- 1f3dc0c: Fix: router now registers on Docker, WSL-without-systemd, and rootless Linux environments via a `crontab @reboot` fallback — previously the wizard printed "run it manually" and silently left the router unregistered. 80% of recent real installs hit this path and ended up with `service: false`, no persistent router, and zero routing activity.

  New behavior for environments without systemd:

  - Writes a wrapper shell script to `~/.robot-resources/rr-router-run.sh` that sources provider env + launches the router
  - Installs a `@reboot` crontab entry pointing at the wrapper — **survives reboot**
  - Immediately spawns the router detached (nohup) so :3838 is live before the wizard's health check
  - Writes `~/.robot-resources/.crontab-installed` marker so `uninstallService()` can clean up

  If cron itself is unavailable (extremely locked-down containers), the wizard falls back to the previous "run manually" message — no regression.

## 1.9.0

### Minor Changes

- cb8f10f: Windows support for router service registration via Task Scheduler.

  The wizard now registers `RobotResourcesRouter` as a user-scoped scheduled task triggered on logon, with a generated `.cmd` wrapper at `~/.robot-resources/rr-router-run.cmd` that sources `~/.robot-resources/router.env` and launches the venv python against `robot_resources.cli.main start`. No admin required.

  `installService()` / `isServiceRunning()` / `isServiceInstalled()` / `uninstallService()` all branch to a `schtasks.exe` implementation on `process.platform === 'win32'` — joining the same lifecycle as launchd (macOS) and systemd (Linux). `isServiceRunning()` uses the locale-independent `0x41301` (TASK_RUNNING) HRESULT from `schtasks /query /fo LIST /v`, not the localized Status column. Uninstall stops the running task (`schtasks /end`), removes the definition (`schtasks /delete /f`), and unlinks the wrapper; the env file is preserved to match Linux/macOS.

  Both wizards (unified CLI + standalone router) previously short-circuited on Windows with "automatic service not supported." That branch is removed — Windows now flows through the normal `installService(getVenvPythonPath())` path.

  Existing Windows installs that completed the wizard before this release can re-run `npx robot-resources` to pick up the scheduled task.

### Patch Changes

- Updated dependencies [0814ae7]
  - @robot-resources/openclaw-plugin@0.5.9

## 1.8.2

### Patch Changes

- 6eedd3a: Fix: installPluginFiles now copies the plugin's `lib/` directory, not just the three top-level files. Since plugin 0.5.5 the shim in `index.js` imports `./lib/plugin-core.js` and friends — without this, every fresh install produces a plugin directory with an `index.js` that fails to load with `MODULE_NOT_FOUND`, emits zero telemetry, and can't self-update (the update mechanism lives in the missing `lib/update-check.js`). Confirmed on a live droplet: `~/.openclaw/extensions/openclaw-plugin/lib/` was empty after `npx robot-resources` on a fresh 0.5.6 install, causing silent plugin failure.

  Any agent that installed 0.5.5 or 0.5.6 before this CLI release needs to re-run the wizard once to pick up the fix. After that, the plugin's own self-update path handles future releases.

## 1.8.1

### Patch Changes

- Fix wrong SDK base_url instructions printed by `printManualInstructions()`. The previous output set `ANTHROPIC_BASE_URL=http://localhost:3838/v1`, but the Anthropic SDK appends `/v1/messages` itself — so the request hit `/v1/v1/messages` (404). Corrected to `http://localhost:3838` (no `/v1`). Also removed the misleading `GOOGLE_API_BASE` line: that env var doesn't exist for the Google SDK, and the router has no native Google endpoints. Gemini users should route through the OpenAI-compatible client. Verified empirically against the running router on 2026-04-14.

## 1.8.0

### Minor Changes

- Enterprise wizard support: the wizard now auto-configures Claude Code and Cursor as MCP clients, prints copy-pasteable SDK base_url instructions when no tools are detected, suppresses "Notify your human" noise for enterprise installs (`RR_API_KEY` pre-set), and shows actionable Docker instructions (Dockerfile CMD, Compose sidecar, background process) instead of a bare command.

## 1.7.9

### Patch Changes

- 87b8082: Wizard telemetry hardening: add `wizard_started` funnel marker and add retry-once to the `install_complete` ping.

  - `wizard_started` is fired immediately after the api_key signup and before any install steps. Pairs with the existing `install_complete` event to give us a "started → completed" funnel for diagnosing wizards that die mid-install. Pure instrumentation, no user-visible change.
  - `install_complete` now retries once on failure with a 10-second timeout per attempt (up from a single 5-second attempt). Catches client-side aborts that previously left signups without an `install_complete` event in the database. Still fire-and-forget — never fatal.

## 1.7.8

### Patch Changes

- cedd4ea: fix: repository URLs point to public repo, consistent homepages, clean README

  All 7 packages now reference github.com/robot-resources/packages (public).
  README rewritten: zero monorepo internals, agent compatibility table, no broken links.
  openclaw-plugin homepage added. scraper/scraper-mcp homepage normalized.

- Updated dependencies [cedd4ea]
  - @robot-resources/cli-core@0.1.4
  - @robot-resources/openclaw-plugin@0.5.3
  - @robot-resources/scraper@0.3.1

## 1.7.4

### Patch Changes

- fix(cli): gateway restart moved to absolute last position (after health check + status file), silent catch, sleep 5s. Incorporates Manuel's week-long Telegram testing feedback.

## 1.7.3

### Patch Changes

- fix(cli): deferred gateway restart — prevents OC session kill on Telegram/Discord. Wizard exits first, gateway restarts 3s later via detached process. Dead code removed (spawnWithHeartbeat).

## 1.7.2

### Patch Changes

- 1ea0fd6: Gateway restart retry (3x with backoff) instead of silent failure. Health check endpoint fix (/v1/health → /health). Users now see clear warning if gateway restart fails.
- Updated dependencies [1ea0fd6]
  - @robot-resources/openclaw-plugin@0.5.1

## 1.7.0

### Minor Changes

- d90537f: feat: make scraper the default web fetch tool in OpenClaw

  - CLI registers scraper-mcp in openclaw.json so OC discovers scraper tools at startup
  - Plugin hooks before_tool_call to intercept web_fetch and route through scraper_compress_url
  - Removed stale Claude Desktop/Cursor references from docs

- 36cd339: fix: consolidate scraper MCP into scraper core, eliminate 60s wizard gap

  - Moved MCP server code into @robot-resources/scraper as a bin entry (scraper-mcp)
  - Removed separate @robot-resources/scraper-mcp download from wizard (was 60s of silence)
  - Updated openclaw.json registration to use bundled scraper-mcp binary
  - No more redundant package downloads during npx robot-resources

### Patch Changes

- 7f944e8: Add install_complete telemetry ping to CLI wizard and router first-run setup
- 5664a0c: fix: proper scraper installation step, remove CLI path, fix SSL fallback

  - Added dedicated scraper installation step in wizard (pre-cache package, verify MCP registration, report status)
  - Removed CLI URL-accepting logic from bin/setup.js — scraper is MCP-only for agents
  - Auto mode now falls back to stealth on TLS/SSL errors (UNABLE_TO_GET_ISSUER_CERT_LOCALLY)
  - Cleaned all docs (llms.txt, llms-full.txt, README, ai-resources.json) to remove CLI references
  - Wizard summary now reports scraper_compress_url(url) explicitly

- Updated dependencies [157c304]
- Updated dependencies [d90537f]
- Updated dependencies [36cd339]
- Updated dependencies [5664a0c]
  - @robot-resources/scraper@0.3.0
  - @robot-resources/openclaw-plugin@0.5.0
