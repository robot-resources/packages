# robot-resources

## 1.14.0

### Minor Changes

- 06f094b: feat(cli): Windows NODE_OPTIONS support via `setx` (Phase 9)

  Closes the platform's last visible non-OC install gap. Pre-Phase-9, Windows wizard runs returned `shell=unsupported, files=None` — the wizard correctly identified the platform and emitted telemetry, but installed nothing actionable. 50% of the post-Phase-8 cohort (`12d09b20`, `34c6b8fb`) hit this gap.

  **Mechanism.** Mirror the POSIX flow at the registry layer:

  1. Reuse `installRouterFiles()` from Phase 8 (`homedir()` is platform-aware — works as-is on Windows).
  2. New `windows-env.js` module wraps `setx.exe` to write `NODE_OPTIONS` into `HKCU\\Environment`. Read existing value via `reg query`, append our `--require "<auto.cjs absolute path>"` (idempotent — no-op if already present).
  3. New cmd / PowerShell / Win+R-launched Node processes inherit the variable.

  **Why `setx` not PowerShell `$PROFILE`:** PR #141 (the deleted Task Scheduler work) explicitly chose `.cmd` over `.ps1` because corporate ExecutionPolicy on locked-down fleets often blocks unsigned `.ps1`. `setx` is universal across cmd + PowerShell + Win+R-launched processes, no admin needed.

  **Why not just append to PowerShell `$PROFILE`:** `$PROFILE` only affects PowerShell; Win+R-launched `node.exe` and cmd-launched processes miss it. Registry-level write covers all entry points.

  **Safety properties:**

  - **Preserves user tooling** (dd-trace, OpenTelemetry, etc.). Reads the prior `NODE_OPTIONS` from `HKCU\\Environment` first, appends our flag after, never clobbers.
  - **Idempotent.** Detects our `--require <abs path>` already in the value and short-circuits.
  - **Refuses to write over the `setx` 1024-char limit.** Returns `setx_limit_exceeded` rather than silently truncating into a broken NODE_OPTIONS that would crash every Node command.
  - **Backup + restore on uninstall.** Pre-modification value saved to `~/.robot-resources/windows-prior-node-options.txt`. `--uninstall` restores it (or clears the var if no backup).

  **Files:**

  - `packages/cli/lib/windows-env.js` — NEW. `readPersistedNodeOptions`, `writePersistedNodeOptions`, `removePersistedNodeOptions`. ~180 lines.
  - `packages/cli/lib/install-node-shim.js` — `if (process.platform === 'win32')` branch routes to the new helper instead of returning `unsupported`.
  - `packages/cli/lib/uninstall.js` — Windows branch calls `removePersistedNodeOptions` instead of `removeShellLine`.
  - `packages/cli/lib/non-oc-wizard.js` — post-install message branches POSIX vs Windows (cmd terminal vs `source ~/.zshrc`).
  - `packages/cli/test/windows-env.test.mjs` — NEW, 12 tests across read / write / remove paths.
  - `packages/cli/test/install-shims.test.mjs` — Windows tests rewritten for the new behavior. 5 cases: happy path, already-installed, setx-limit, setx-failure, copy-failure.

  **Tests:** 265/265 CLI tests pass (17 new).

  **New telemetry payload fields (`node_shim_installed` on Windows):**

  - `shell: 'win32'`
  - `shell_config_path: 'HKCU\\Environment\\NODE_OPTIONS'`
  - `win_node_options_length: <int>` — surfaces real-world value sizes so we can spot truncation pressure in Supabase
  - `reason: 'setx_limit_exceeded' | 'setx_failed' | 'router_copy_failed' | null`

  **What's NOT in this PR (still uncovered):**

  - Docker / Kubernetes containers (no shell, env from entrypoint)
  - Serverless (Lambda / Cloud Run / Vercel Functions — NODE_OPTIONS often sandboxed away)
  - Bun (uses `--preload` instead of `--require`)
  - Deno (no NODE_OPTIONS)

  These need different mechanisms (Dockerfile snippets, IaC env injection, runtime-specific adapters) and aren't a single-wizard fix. The May 1 cohort taught us not to design ahead of telemetry — wait for those cohorts to show up before building for them.

  **Stranded users:** the 4 Linux users from the broken-NODE_OPTIONS pre-Phase-8 era still have their broken `.bashrc` lines. The 2 Windows users from the post-Phase-8 cohort still got nothing. None auto-recover. They need to re-run `npx robot-resources@latest` (or manually clean their shell config / registry).

## 1.13.0

### Minor Changes

- 73e9d98: fix(cli): NODE_OPTIONS uses absolute path to copied router files (Phase 8)

  **Root cause for `adapter_attached: 0` in Supabase despite `node_shim_installed: 8`.**

  The Phase 3-7 wizard wrote a NODE_OPTIONS line of the form:

  ```sh
  export NODE_OPTIONS="${NODE_OPTIONS:-} --require @robot-resources/router/auto"
  ```

  Node's `--require` uses the same module resolution as `require()` from the current working directory. The bare module form `@robot-resources/router/auto` only resolved when the user was `cd`'d inside a project that had `@robot-resources/router` in its node_modules. From any other cwd (their home, a Python project, etc.) **Node crashed with `Cannot find module '@robot-resources/router/auto'`** — every `node` / `npm` / `npx` command in that shell was broken.

  The 4 Linux users with `node_shim_installed` events on May 2-3 had this broken line in their `.bashrc`. The shim never executed because Node never even started. Result: zero `adapter_attached`, zero `route_completed` from any of them.

  **Fix.** Mirror the OC plugin path's pattern (`installPluginFiles()` in `tool-config.js`): copy the router files to a stable user-scoped absolute location, then write that path in NODE_OPTIONS.

  ```sh
  export NODE_OPTIONS="${NODE_OPTIONS:-} --require /Users/x/.robot-resources/router/auto.cjs"
  ```

  Wizard now:

  1. Resolves `@robot-resources/router` from its own dependency tree (`require.resolve('@robot-resources/router/package.json')`).
  2. Copies `auto.cjs` + `index.js` + `package.json` + `lib/` to `~/.robot-resources/router/`. lib/ is wiped first so router upgrades don't accumulate stale files.
  3. Returns the absolute path to `auto.cjs`.
  4. `writeShellLine({ autoPath })` builds the NODE_OPTIONS line with that absolute path.

  Result: NODE_OPTIONS works from any cwd. Self-contained. Survives npm/npx cache cleanup.

  **Files:**

  - `packages/cli/lib/install-router-files.js` — NEW. Extracted for testability.
  - `packages/cli/lib/install-node-shim.js` — calls `installRouterFiles()` first, fails the install (with telemetry) if the copy throws.
  - `packages/cli/lib/shell-config.js` — `writeShellLine` now takes `{ autoPath }` (required); `POSIX_LINE` / `FISH_LINE` constants replaced with `buildPosixLine` / `buildFishLine` factories.
  - `packages/cli/lib/uninstall.js` — also removes the copied `~/.robot-resources/router/` dir on `--uninstall`.
  - `packages/cli/test/shell-config.test.mjs` + `install-shims.test.mjs` — updated for new signatures, +3 new tests covering Phase 8 absolute-path behavior + router-copy-failure path.

  **Live verified end-to-end:**

  1. Wizard runs in a project dir → copies router files to `~/.robot-resources/router/`, writes NODE_OPTIONS with absolute path
  2. Open a Node shell from `/tmp` (not the project dir, not anywhere with the package): Node loads the shim, `ANTHROPIC_BASE_URL` set to localhost ✓
  3. `--uninstall` removes both the shell line AND the copied router dir ✓

  **Tests:** 248 CLI tests pass.

  **Telemetry:** `node_shim_installed` gains `auto_path` field so we can verify in Supabase that future events carry the absolute path. New `reason` value `router_copy_failed` for the cold-EACCES case.

  **Stranded user note:** The 4 existing Linux users with broken NODE_OPTIONS lines (`5a4d433d`, `e935e9dc`, `364e1db1`, `f89f305f`) need to either:

  - Manually remove the marker block from their shell rc, OR
  - Re-run `npx robot-resources@latest` to overwrite with the new absolute path

  We have no remote-push channel. Worst case, their broken NODE_OPTIONS is silently breaking every Node command they run.

## 1.12.4

### Patch Changes

- 3df9cf9: fix(router,cli): lift RR_AUTOATTACH gate — auto-attach is now the default (Phase 7)

  Critical fix. The 3 successful Phase 3-flow installs (real users on `1.12.2`/`1.12.3` whose wizard completed `node_shim_installed`) were producing **zero `adapter_attached` and `route_completed` events**. They had the shim installed but it was a no-op.

  **Root cause:** `auto.cjs` and `_autoattach/__init__.py` shipped Phase 1+2 with a `RR_AUTOATTACH=1` gate at the top — opt-in until the bundler matrix was proven. The original plan had Phase 3 lift the gate; that step got missed. The wizard wrote `NODE_OPTIONS=--require @robot-resources/router/auto` to user shells, the shim loaded, hit the gate, **early-returned without setting `ANTHROPIC_BASE_URL` or starting the local server**. SDK calls went straight to api.anthropic.com — no routing, no swap, no telemetry.

  **Fix:** invert the gate to opt-out. Default is now ON. Users who specifically want to bypass the shim for one process set `RR_AUTOATTACH=0`. Same env var, opposite polarity.

  **Second fix in the same PR:** the previous all-or-nothing early-return for a user-set `ANTHROPIC_BASE_URL` is replaced by per-SDK respect. If the user set `ANTHROPIC_BASE_URL` to a corp proxy, we leave that alone but still attach OpenAI + Google. One custom env var no longer kills the other adapters.

  **Wizard message update:** the Phase 3 install message told Python users to `set RR_AUTOATTACH=1` in their shell. That's now wrong (and probably caused some of the silent-failure cohort). Replaced with: "Run your Python agent — every anthropic / openai / google_generativeai SDK call routes through Robot Resources automatically. To opt out for a single command: `RR_AUTOATTACH=0 python your-script.py`".

  **Files:**

  - `router/packages/router/auto.cjs` — gate inverted, all-or-nothing user-override removed
  - `router/packages/router/test/auto-attach.test.mjs` — 5 tests updated for opt-out semantics
  - `python/robot-resources/src/robot_resources/_autoattach/__init__.py` — gate inverted
  - `python/robot-resources/tests/test_autoattach.py` — 3 gating tests updated
  - `python/robot-resources/pyproject.toml` — bumped to **0.4.0** (manual publish required)
  - `python/robot-resources/src/robot_resources/__init__.py` — version bump
  - `packages/cli/lib/non-oc-wizard.js` — wizard install message no longer instructs users to set `RR_AUTOATTACH=1`

  **Tests:** 357 router + 245 CLI + 46 Python = 648/648 pass.

  **Manual publish required after merge:**

  ```
  cd python/robot-resources
  rm -rf dist && python3 -m build && python3 -m twine upload dist/*
  ```

  **Stranded users:** the existing successful-install non-OC users (`364e1db1`, `f89f305f`, `1bba3b7d`) have OLD shims cached in their npm cache or installed site-packages. Their NODE_OPTIONS still points at `@robot-resources/router/auto` from `4.4.0`, which has the old gate. Until they re-install (e.g. `npx robot-resources` re-fetches `4.4.1` or `pip install --upgrade robot-resources` lands `0.4.0`), they remain in the silent-failure state. We have no remote-push mechanism for them.

  For users running `npx robot-resources@latest` AFTER `1.12.4` ships: clean install, default ON, immediately produces `route_completed` events on first agent call.

- Updated dependencies [3df9cf9]
  - @robot-resources/router@4.4.1

## 1.12.3

### Patch Changes

- 85312d2: fix(cli): timeout fallback on interactive prompt for hung-but-claimed-interactive sessions (Phase 3.6)

  The 5 RU users that signed up at 23:31 UTC ran `npx robot-resources` against `1.12.1`/`1.12.2` with `non_interactive: false`. They produced `wizard_started` but **no `wizard_path_chosen`** — neither a pick nor a Ctrl-C abort. Symptom: their environment reports `process.stdin.isTTY === true` so the wizard enters the interactive `select()` branch, but no keystroke ever arrives. `@inquirer/prompts.select` blocks indefinitely; the process exits silently before any path event fires.

  Phase 3.5 fixed the symmetric bug for `nonInteractive=true` (wizard knows it's non-interactive but bails). This is the inverse: wizard _thinks_ it's interactive but the session is hung.

  **Fix** (one-file change in `packages/cli/lib/non-oc-wizard.js`): race the `select()` against a 30s timeout. On timeout:

  - If `detectAgentRuntime()` returns `'node'` / `'python'` / `'both'` → auto-install matching shim (mirror Phase 3.5).
  - Otherwise → emit a new `wizard_path_chosen` value `path='interactive_timeout'` so the funnel can segment "hung session, no project on disk" from genuine `'aborted'` and `'noninteractive_no_target'` cases.

  Override available: `RR_WIZARD_SELECT_TIMEOUT_MS=<ms>` (used by tests; can also extend the timeout for slow human typists if anyone complains).

  The timer is `unref()`-ed so a quick user pick lets the process exit without waiting for the timer.

  **Tests:** 4 new in `non-oc-wizard.test.mjs` covering Node-cwd timeout / Python-cwd timeout / empty-cwd timeout / user-picks-before-timeout. 245/245 CLI tests pass.

  **Telemetry:** new `wizard_path_chosen` value `'interactive_timeout'` for empty-cwd hung sessions. Auto-install fallback emits the canonical `'js'` / `'python'` (no new event types) so the existing funnel join keeps working.

## 1.12.2

### Patch Changes

- d9f0f9d: fix(cli): auto-install matching shim in non-interactive mode when cwd is unambiguous (Phase 3.5)

  Phase 3 closed the visibility gap (we now see `wizard_path_chosen` events for the silent-bail-out branch), but it didn't close the **install** gap. The first 5 post-1.12.0 non-OC users all ran `npx robot-resources` non-interactively without `--for=`, hit the bail-out, and walked away with nothing installed. The Phase 3 wizard required users to pass an explicit target — too much friction for CI/agents that auto-run the wizard from their repo.

  **Fix:** before printing the `--for=` hint and exiting, call `detectAgentRuntime(cwd)` (the existing detector from Phase 3). When the project shape is unambiguous:

  - `kind: 'node'` → auto-run the Node shim install
  - `kind: 'python'` → auto-run the Python shim install
  - `kind: 'both'` → default to Node (per the plan's mixed-cwd decision)
  - `kind: null` → fall through to today's print-hint exit (truly empty cwds still get the hint)

  Single file change (`packages/cli/lib/non-oc-wizard.js`), ~15 lines of real logic.

  **Live verification (3 cwd shapes against this branch):**

  - `package.json` + `@anthropic-ai/sdk` → wrote `NODE_OPTIONS` to `~/.zshrc` ✓
  - `requirements.txt` + `anthropic` (with `./.venv`) → ran `pip install --upgrade robot-resources>=0.2.0` against the venv ✓
  - Empty cwd → printed the `--for=` hint, exited (preserved Phase 3 behavior) ✓

  **Tests:** 5 new in `non-oc-wizard.test.mjs` (auto-install Node / Python / both, preserve hint when null, telemetry skip without api_key). 241/241 CLI tests pass.

  **Telemetry:** the auto-install path emits `wizard_path_chosen` with `path='js'` or `path='python'` so it joins cleanly with the existing funnel queries — no new event types.

## 1.12.1

### Patch Changes

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

- Updated dependencies [73664c1]
- Updated dependencies [70159b0]
  - @robot-resources/router@4.4.0

## 1.12.0

### Minor Changes

- 20650d9: feat(cli): wizard rewrite — installs the Node + Python shims for non-OC agents (Phase 3)

  Phase 3 of the universal-installer refactor. The non-OC wizard branches stop printing docs links and **start actually installing routing into the agent's runtime**.

  **Node path** (`npx robot-resources --for=langchain` or interactive "JS/TS agent"):

  - Detects active shell rc files (`~/.zshrc`, `~/.bashrc`, `~/.bash_profile`, `~/.config/fish/config.fish`).
  - Appends a marker block with `NODE_OPTIONS="${NODE_OPTIONS:-} --require @robot-resources/router/auto"`.
  - Idempotent — re-runs are no-ops. `--uninstall` cleanly removes the block.
  - Falls back to printed instructions on Windows (Phase 6 problem).
  - Conflict-aware: appends after any existing `--require` (preserves dd-trace, etc.).

  **Python path** (`npx robot-resources --for=python` or interactive "Python agent"):

  - Detects an active or cwd venv: `$VIRTUAL_ENV` → `./.venv` → `./venv` → bail with `--python=` instructions.
  - **Never silently installs into system Python** (can break OS Python on Linux).
  - Runs `pip install --upgrade robot-resources>=0.2.0` against the resolved interpreter.
  - Captures pip stderr tail for telemetry on failure.

  **New telemetry events:**

  - `node_shim_installed` — `{shell, shell_config_path, sdks_detected, files_written, files_with_errors, error_messages, dry_run, already_installed}`. Joins to `wizard_path_chosen` (path=`js`) under the same `api_key_id`.
  - `python_shim_installed` — `{kind, python_version, sdks_detected, pip_exit_code, pip_stderr_tail}`. Joins to `wizard_path_chosen` (path=`python`).
  - `wizard_started` payload gains `entry: 'oc' | 'non-oc'`, finer than the existing `openclaw_detected` boolean.

  **Uninstall extended** (`npx robot-resources --uninstall`):

  - Phase 0 already removed OC plugin dirs + `openclaw.json` entries.
  - Now also: removes the shell-config marker block, runs `pip uninstall -y robot-resources` against the resolved venv. Both idempotent.

  **Files added:**

  - `packages/cli/lib/shell-config.js` — marker-block writer for POSIX shells. Functions: `writeShellLine`, `removeShellLine`, `hasShellLine`, `listShellRcFiles`.
  - `packages/cli/lib/venv-detect.js` — Python interpreter resolution (active → cwd venv → bail). `runPipInstall` runner with bounded stderr capture.
  - `packages/cli/lib/install-node-shim.js` — orchestrates the Node path (detect → write → telemetry).
  - `packages/cli/lib/install-python-shim.js` — orchestrates the Python path (detect → pip → telemetry).

  **Files extended:**

  - `packages/cli/lib/detect.js` — adds `detectNodeAgent`, `detectPythonAgent`, `detectAgentRuntime` (cwd dependency-marker scanners).
  - `packages/cli/lib/non-oc-wizard.js` — `showJsPath` and `showPythonPath` now invoke the install helpers; printed instructions become the failure fallback.
  - `packages/cli/lib/uninstall.js` — adds shell-line removal + pip uninstall to `runUninstall`.
  - `packages/cli/lib/wizard.js` — adds `entry` tag to `wizard_started`.

  **Tests:** 49 new (220 → 234 across the workspace) covering shell-config marker semantics, venv resolution order, install-shim orchestration, agent-runtime detection. All 234 pass.

  **Behavior decisions** (from the plan):

  - NODE_OPTIONS conflict → append after existing `--require` (preserves user tooling).
  - Mixed cwd (package.json + pyproject.toml) → existing `detectDefaultPath` keeps the JS-default-in-`--yes` behavior; interactive prompt lets users pick.
  - Consent → `writeShellLine` writes silently in `--yes` (matches existing wizard convention at `setup.js:7`).

  **Lifts the `RR_AUTOATTACH=1` gate from Phases 1+2.** New wizard runs that complete the Node or Python path will produce real `route_completed` events — the first non-OC routing volume the platform has ever seen.

  **Out of scope:**

  - Windows shell-config (Phase 6 — printed-instructions fallback for now).
  - OpenAI + Google adapters (Phase 4).
  - `npx @robot-resources/router` standalone wizard (Phase 5).
  - Wizard-time prompt to disambiguate mixed cwd interactively (current behavior: `detectDefaultPath` returns `js`, user can override at the menu).

## 1.11.2

### Patch Changes

- 39d3dae: feat(cli): close non-OC funnel-completion telemetry holes + add `--uninstall`

  Phase 0 of the universal-installer refactor. Two changes, both small.

  **Telemetry holes.** The non-OC wizard had two silent-return paths that never emitted `wizard_path_chosen`:

  1. `--non-interactive` with no `--for=<target>` printed the hint and returned. The May 1 cohort confirmed this — a JP user (non_interactive=true) signed up, hit `wizard_started`, then disappeared. Now emits `wizard_path_chosen` with `path: 'noninteractive_no_target'`.
  2. Interactive prompt aborted via Ctrl-C / `ABORT_ERR` returned silently. The 3 RU users with `non_interactive=false` likely hit this (UA=`node` in non-TTY env makes `@inquirer/prompts.select` throw). Now emits `wizard_path_chosen` with `path: 'aborted'`.

  The funnel `wizard_started` → `wizard_path_chosen` is now closed end-to-end. Both new paths share the existing event type so the Supabase funnel query stays single-event.

  **`--uninstall` flag.** `npx robot-resources --uninstall` removes the OC plugin install side: the two plugin directories under `~/.openclaw/extensions/`, plus our entries from `openclaw.json` (`plugins.entries`, `plugins.allow`, `mcp.servers`). Idempotent and surgical — leaves other plugins / MCP servers untouched. `~/.robot-resources/config.json` is preserved by default so reinstalling reuses the same `api_key`. `--purge` also wipes the config dir.

  Telemetry: emits `wizard_uninstalled` with `components_removed` so we get a churn signal.

  This is the trust foundation before Phase 1 (in-process SDK adapters for non-OC Node + Python agents).

## 1.11.1

### Patch Changes

- fd2e601: fix(cli): provision api_key + emit wizard_started for non-OpenClaw wizard runs

  The wizard returned into the non-OC branch before Step 0 (signup) and the `wizard_started` emit ever executed, leaving every non-OpenClaw install invisible to telemetry — no `api_keys` row, no `agent_signup_meta`, no `wizard_started`. The non-OC wizard's existing `wizard_path_chosen` event was dead code too, since it bails on missing api_key. Past 14 days: 1,339 npm downloads, 3 `agent_signup_meta` events.

  Hoist signup + `wizard_started` above the OC-detect branch so both paths funnel through them. Tag the `wizard_started` payload with `openclaw_detected` (matching the `install_complete` payload convention) so OC vs non-OC funnels can be segmented from a single event type. The non-OC wizard's `wizard_path_chosen` starts firing automatically as a side effect.

  Product behavior is unchanged for OpenClaw users; the non-OC path's UX is unchanged. This is a measurement fix.

## 1.11.0

### Minor Changes

- e1d5c56: feat(cli): interactive non-OC wizard with detection-driven defaults — replaces PR 3's print-and-exit. 5-option menu (JS / Python / Cursor-or-Claude-Code MCP / docs / install OC) via `@inquirer/prompts`. Detects cwd `package.json` / `requirements.txt` / `pyproject.toml` / `~/.cursor` / `~/.claude` to preselect the right path. New `--for=<target>` flag lets CI / non-TTY callers pick a path without prompting (`langchain`, `python`, `cursor`, `claude-code`, `docs` aliases supported). `bin/setup.js` now also auto-detects non-TTY via `process.stdin.isTTY && process.stdout.isTTY`. New `wizard_path_chosen` telemetry event tracks conversion. Plus 7 framework integration pages added to web at `/docs/{,langchain,langgraph,mastra,crewai,http-api,cursor-mcp}` so the wizard's printed URLs resolve to real content.

### Patch Changes

- Updated dependencies [e1d5c56]
  - @robot-resources/router@4.2.0

## 1.10.6

### Patch Changes

- ad61708: Inlined former `@robot-resources/cli-core` modules (auth.mjs, config.mjs, login.mjs) into `packages/cli/lib/`. Auth/config/login flows unchanged. The cli-core npm package is deprecated post-merge with a redirect to `npx robot-resources`. Last workspace consolidation in the Router refactor — workspace ships exactly three npm packages now: `@robot-resources/router`, `@robot-resources/scraper`, `robot-resources`.

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
