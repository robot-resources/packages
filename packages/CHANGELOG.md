# @robot-resources/cli-core

## 0.1.8

### Patch Changes

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

## 0.1.7

### Patch Changes

- b93eab5: Fix: `uv` bootstrap failed on Docker and some VPS setups with:

  ```
  EXDEV: cross-device link not permitted
  rename '/tmp/rr-uv-extract-.../uv' → '/root/.robot-resources/bin/uv'
  ```

  `fs.renameSync()` can't rename across filesystems. On Docker (tmpfs `/tmp` vs overlay `/root`) and on Hetzner A100 ROW VPS (same pattern), the source and destination sit on different mounts. Two real users hit this today (`af90eceb`, `1236681a` — both DE, same A100 ROW ASN) — our uv-bootstrap extracted uv correctly, then crashed trying to move it into place.

  Fix: on `EXDEV`, fall back to `copyFileSync` + `unlinkSync`. Same-filesystem renames still take the fast path.

## 0.1.6

### Patch Changes

- ffa5a26: Fix: two install failures surfaced by today's telemetry are now handled.

  **1. `tiktoken` wheel-build failures (2 RU users, `wheel_build_failed`).** The `tiktoken` Python package needs either a pre-built wheel OR a Rust compiler to build from source. When neither is available (unusual Python/OS/arch combos), pip install fails completely.

  Fix: `tiktoken` moved from required `dependencies` to the `[tokenizer]` extra in `robot-resources-router`. The router's tokenizer module already has a runtime fallback to `len(text) // 4` when tiktoken is unavailable. CLI wizards now do a two-step install — try `robot-resources-router[tokenizer]` first, fall back to the bare install on wheel-build failure. Routing still works either way; only exact BPE token counts become approximate.

  **2. `python3-venv` module missing (1 DE user, previously classified `unknown`).** Debian/Ubuntu ships `python3` without the `venv` module — it's a separate apt package. `findOrInstallPython()` now detects this case and falls back to uv-managed Python (which has venv built in) instead of throwing the old "apt install python3-venv" error.

  **Also:**

  - New error classifier reasons: `python_venv_missing`, `wheel_build_failed`
  - Classifier now inspects stderr (not just the exception message) so failures that leave the reason text in the pip subprocess output get categorized correctly
  - No behavior change when everything works — only affects failure paths

## 0.1.5

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

## 0.1.4

### Patch Changes

- cedd4ea: fix: repository URLs point to public repo, consistent homepages, clean README

  All 7 packages now reference github.com/robot-resources/packages (public).
  README rewritten: zero monorepo internals, agent compatibility table, no broken links.
  openclaw-plugin homepage added. scraper/scraper-mcp homepage normalized.
