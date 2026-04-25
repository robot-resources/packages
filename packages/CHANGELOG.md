# @robot-resources/openclaw-plugin

## 0.6.0

### Minor Changes

- b9e8a7c: Route in-process: the plugin now performs routing decisions locally in JS
  instead of calling the Python router daemon over HTTP. HTTP fallback retained
  for one release as a safety net (deleted in PR 3).

  The keyword fast-path handles ~70% of prompts in <5ms; the slow path calls
  the platform classifier (Gemini) for low-confidence prompts. Hybrid provider
  detection inspects both `api.config.models.providers` and the standard env
  vars (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_API_KEY` /
  `GEMINI_API_KEY`) — when no providers are detected, the plugin emits
  `no_providers_detected` telemetry and skips the override so OC falls
  through to its own default model.

  `api.registerProvider(...)` and the `providers` field in the manifest are
  removed: with in-process routing OC handles requests using the user's own
  provider keys via `modelOverride`/`providerOverride` from the
  `before_model_resolve` hook. Subscription-mode detection (dead since
  Anthropic blocked subscription tokens 2026-04-04) is left wired in PR 2 to
  keep this diff tight; cleanup deferred to PR 3 or PR 4.

  This release also publishes the PR 1 routing port (`lib/routing/`) which
  shipped without a changeset.

## 0.5.12

### Patch Changes

- 5a998c8: Four coordinated fixes so the router actually survives past the wizard:

  - **CLI (service.js):** systemd-user install now verifies `loginctl enable-linger` actually took effect (the Finland signup on 2026-04-23 proved the silent-failure case is real) and installs a `crontab @reboot` belt alongside the user unit so the router comes back after reboot even when linger is denied by polkit.
  - **Plugin (plugin-heal.js):** new parallel healer runs on every OpenClaw gateway start. Pings `/health`, and if the router is dead it runs enable-linger, tries `systemctl --user restart`, falls back to a detached spawn, and polls until healthy. Acquires a PID-based lock (`~/.robot-resources/.heal.lock`) to avoid racing the router's own self_heal. Throttled to once per hour via a separate marker. Plugin now rescues users whose router died post-install — the router's own self_heal can't reach them.
  - **Worker + plugin (response channel):** the telemetry POST response now optionally carries `heal_hints` — a strict allowlist (`reheal_router` | `rerun_wizard`). Server decides based on the current event batch; plugin maps recognized hints to local actions (force-run the heal bypassing the throttle; surface a nag asking the user to re-run `npx robot-resources`). No arbitrary commands. Plugin silently drops anything outside the allowlist.
  - **Install_complete payload:** adds `linger_enabled` and `crontab_fallback` so we can tell which systemd-user installs are live-forever setups vs dying-on-logout.

## 0.5.11

### Patch Changes

- 99c45f7: Plugin: `register()` is now idempotent at the work level. OpenClaw calls `register()` multiple times per session (once per internal subsystem); the first call runs the setup (hooks, tool, provider, fresh-install ack) and subsequent calls in the same process skip that block. Pairs with the existing `plugin_register` telemetry-dedup guard from 0.5.10. No observable behavior change for users — removes redundant registration work.

## 0.5.10

### Patch Changes

- 0cea7e1: Fix: `plugin_register` telemetry now emits at most once per plugin-load process. OpenClaw invokes `register()` multiple times per session (once per internal subsystem — model resolver, tool dispatch, hook registration, etc.), producing 3-4 `plugin_register` events for a single actual plugin load. That inflated every "distinct install" adoption metric by 3-4x. A module-level guard now suppresses re-emits. Still captures the first load per process, which is what the heartbeat was designed to signal.

## 0.5.9

### Patch Changes

- 0814ae7: Enable plugin self-update on Windows via deferred swap.

  PR #128 shipped self-update for macOS/Linux but explicitly skipped Windows because NTFS won't let you rename over open files — the in-place swap at `performSelfUpdate` fails while Node has the plugin's `.js` files loaded. Windows installs since 0.5.5 have been frozen on whatever version they installed with.

  The fix stages the new payload into `{installDir}/.pending-<to>/` with a marker at `~/.robot-resources/.pending-swap.json`. On the next OpenClaw session the shim (`index.js`) runs `applyPendingSwap()` synchronously before the dynamic `import('./lib/plugin-core.js')` — the one moment where Node hasn't yet opened the payload files and NTFS share locks aren't held. The backup, rename, and rollback semantics are identical to the Unix path; only timing differs.

  Failure recovery: a failed swap quarantines `.pending-*` to `.failed-pending-<to>-<ts>/`, arms the 24h update-skip window, and emits `plugin_update_swap_failed`. If the subsequent plugin-core import itself fails, `safe-load.js` still rolls back from `.bak-<from>/` exactly as before.

  Existing Windows installs on the pre-fix code still need one manual `npx robot-resources` re-run to bootstrap onto this release; from there self-update works forever, same as Unix.

  New CI matrix job runs the plugin test suite on `ubuntu-latest`, `macos-latest`, and `windows-latest`.

## 0.5.8

### Patch Changes

- 813d154: Fix: plugin fails to load with `SyntaxError: await is only valid in async functions and the top level bodies of modules`. OpenClaw loads plugins via jiti in CJS-compatible mode, which does NOT support top-level await — but the shim introduced in 0.5.5 used `await import(...)` at the top level. Result: every fresh install since 0.5.5 has been silently broken. No `plugin_register` telemetry, no router routing, no `route_completed` events.

  The shim now kicks off the dynamic import as a Promise (no top-level await) and `register()` awaits it before invoking the core. Safe-load rollback behavior is preserved. Confirmed working against a live OpenClaw droplet — plugin loads, `before_model_resolve` fires, routing telemetry flows end-to-end.

  Any agent that installed 0.5.5, 0.5.6, or 0.5.7 should re-run the wizard or let the plugin's self-update ship this fix on the next session load (note: self-update can only run once the plugin loads, which requires this fix — so existing broken installs need a manual wizard re-run once).

## 0.5.7

### Patch Changes

- 67b646a: Fix: restore router telemetry delivery — zero router events since April 5 after PR #108 replaced the working direct POST with a JSONL buffer + background sync that dies with the router process.

  - **Router `telemetry.py`**: `areport_safe()` now posts directly to `/v1/telemetry` (the proven pre-PR#108 path) and only buffers to JSONL on failure. Immediate delivery in the common case, resilience on transient outages.
  - **Router `sync.py`**: `_post_batch()` now treats only 2xx as success (previously counted 4xx like 401/400 as success, silently advancing the buffer offset and permanently losing events). Adds structured logging of HTTP status + body on failure. Adds `RR_API_KEY` env var fallback so enterprise agents with env-var auth get a working sync task.
  - **Plugin `buffer-flush.js`** (new): on plugin load, drains `~/.robot-resources/analytics/router-events.jsonl` and POSTs pending events to the platform — guarantees delivery even if the router process died before its own sync ran. Wired into `plugin-core.js` alongside the heartbeat and update check, same fire-and-forget pattern.

  After any agent re-runs the wizard (or self-updates the plugin to 0.5.7+), router telemetry should resume flowing within seconds of the next routing decision.

## 0.5.6

### Patch Changes

- 6d7bee0: Add `plugin_register` heartbeat event on every plugin load and `plugin_update_check_current` event when the daily update check determines no update is needed. Without these, a healthy install on the latest version emits zero telemetry — we couldn't confirm from Supabase whether the plugin was even loading. With the heartbeat, every OC session start gives us one event tagged with `plugin_version`, so version spread surfaces in `VersionsPanel` regardless of whether anything exceptional happens.

## 0.5.5

### Patch Changes

- e7ea2e9: Plugin self-update. On load (once per 24h) the plugin now polls `/v1/version`, downloads a newer tarball from npm if one exists, verifies its sha1 against the server-reported shasum, and atomic-swaps the files in `~/.openclaw/extensions/openclaw-plugin/`. The update takes effect on the next OpenClaw session — no in-session reload hook exists upstream, so we accept that cadence.

  A thin shim in `index.js` wraps the refactored core (`lib/plugin-core.js`) so a broken release can be caught during module evaluation or `register()`, automatically restored from the `.bak-<prev>/` sibling, and kept out for 24h via `~/.robot-resources/.update-skip-until`. Every step of the flow emits telemetry (`plugin_update_attempted/succeeded/download_failed/failed`, `plugin_rollback_triggered`, `plugin_update_pending_reload`), and all plugin events now carry `plugin_version` in their payload so version spread shows up in the admin dashboard. `tryStartRouter` (the 0.5.4 fix) is instrumented too — we can finally confirm it works in the wild.

  Kill switch: operators can halt updates fleet-wide by setting `PLUGIN_UPDATES_DISABLED=1` on the platform Worker. The flag is overlaid post-cache so flips take effect immediately. Windows is warn-only for now (rename-over-open-file semantics aren't validated).

  Known limit: existing installs on 0.5.3/0.5.4 don't self-heal — they don't have the update code yet. 0.5.5 is the new floor. Future fixes ship themselves.

## 0.5.4

### Patch Changes

- 2c2d44d: Auto-restart the router when it's detected as offline during model routing.

  Previously, when the router process died (e.g., after a session disconnect), the plugin silently fell back to OpenClaw's default model — no routing, no telemetry, no warning. Agents kept working but cost optimization was silently disabled.

  Now the plugin detects the router is unreachable, spawns it as a detached background process (survives session ends), waits for health confirmation, and retries the route. If auto-restart fails, logs a visible warning instead of silently falling back. One restart attempt per plugin lifecycle to prevent spawn-looping.

## 0.5.3

### Patch Changes

- cedd4ea: fix: repository URLs point to public repo, consistent homepages, clean README

  All 7 packages now reference github.com/robot-resources/packages (public).
  README rewritten: zero monorepo internals, agent compatibility table, no broken links.
  openclaw-plugin homepage added. scraper/scraper-mcp homepage normalized.

## 0.5.1

### Patch Changes

- 1ea0fd6: Add observability hooks (after_tool_call, llm_output) for agent debugging. Professional post-install message with [RR:OK] validation tag and new-conversation guidance.

## 0.5.0

### Minor Changes

- d90537f: feat: make scraper the default web fetch tool in OpenClaw

  - CLI registers scraper-mcp in openclaw.json so OC discovers scraper tools at startup
  - Plugin hooks before_tool_call to intercept web_fetch and route through scraper_compress_url
  - Removed stale Claude Desktop/Cursor references from docs
