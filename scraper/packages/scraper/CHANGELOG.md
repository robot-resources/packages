# @robot-resources/scraper

## 0.3.0

### Minor Changes

- 36cd339: fix: consolidate scraper MCP into scraper core, eliminate 60s wizard gap

  - Moved MCP server code into @robot-resources/scraper as a bin entry (scraper-mcp)
  - Removed separate @robot-resources/scraper-mcp download from wizard (was 60s of silence)
  - Updated openclaw.json registration to use bundled scraper-mcp binary
  - No more redundant package downloads during npx robot-resources

### Patch Changes

- 157c304: feat(scraper): CLI accepts URL arguments, removes hardcoded agent detection

  - `npx @robot-resources/scraper <url>` now scrapes and outputs compressed markdown to stdout
  - Supports `--json`, `--mode`, `--timeout` flags
  - Removed `detectAgents()` / `configureAgentMCP()` (hardcoded Claude Desktop/Cursor paths)
  - Usage display now shows generic MCP config snippet instead of auto-configuring specific agents

- 5664a0c: fix: proper scraper installation step, remove CLI path, fix SSL fallback

  - Added dedicated scraper installation step in wizard (pre-cache package, verify MCP registration, report status)
  - Removed CLI URL-accepting logic from bin/setup.js — scraper is MCP-only for agents
  - Auto mode now falls back to stealth on TLS/SSL errors (UNABLE_TO_GET_ISSUER_CERT_LOCALLY)
  - Cleaned all docs (llms.txt, llms-full.txt, README, ai-resources.json) to remove CLI references
  - Wizard summary now reports scraper_compress_url(url) explicitly
