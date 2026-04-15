# @robot-resources/openclaw-plugin

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
