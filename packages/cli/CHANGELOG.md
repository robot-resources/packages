# robot-resources

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
