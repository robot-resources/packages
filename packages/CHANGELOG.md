# @robot-resources/openclaw-plugin

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
