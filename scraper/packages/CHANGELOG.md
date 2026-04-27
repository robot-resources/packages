# @robot-resources/scraper

## 0.5.0

### Minor Changes

- 90bbbd5: Fold `@robot-resources/scraper-tracking` into `@robot-resources/scraper` as a `./tracking` subpath export. Closes the consolidation directive: only `router`, `scraper`, and `cli` workspace packages remain on npm.

  Migration for any external consumer of `@robot-resources/scraper-tracking`:

  ```diff
  -import { calculateTokensSaved } from '@robot-resources/scraper-tracking';
  +import { calculateTokensSaved } from '@robot-resources/scraper/tracking';
  ```

  The published `@robot-resources/scraper-tracking@0.1.0` stays on npm forever; deprecation notice added out-of-band post-publish.

  What changed:

  - `scraper/packages/tracking/src/*` moved to `scraper/packages/scraper/src/tracking/`. Same files (`calculator`, `pricing`, `reporter`, `tracker`, `types`, `index`).
  - `scraper`'s `tsup.config.ts` adds a third entry that emits `dist/tracking.{js,cjs,d.ts,d.cts}`.
  - `scraper`'s `package.json` adds the `./tracking` export with both ESM + CJS conditional resolutions.
  - Tracking's tests automatically join scraper's vitest run via the shared `src/**/*.test.ts` glob — 344 scraper tests now (combining the prior 339 with tracking's 5 files).
  - `scraper-tracking` workspace deleted; root `workspaces` array trimmed; `publish.yml` strips all 5 integration points (paths, outputs, version-check, build/test/publish, git tag).

## 0.4.0

### Minor Changes

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

## 0.3.1

### Patch Changes

- cedd4ea: fix: repository URLs point to public repo, consistent homepages, clean README

  All 7 packages now reference github.com/robot-resources/packages (public).
  README rewritten: zero monorepo internals, agent compatibility table, no broken links.
  openclaw-plugin homepage added. scraper/scraper-mcp homepage normalized.

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
