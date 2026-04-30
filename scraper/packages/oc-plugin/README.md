# @robot-resources/scraper-oc-plugin

OpenClaw plugin that redirects `web_fetch` tool calls to `scraper_compress_url` for token-efficient web reading.

## What it does

When an agent inside OpenClaw tries to call `web_fetch` on a URL, this plugin's `before_tool_call` hook intercepts the call and rewrites it to `scraper_compress_url` (provided by [`@robot-resources/scraper-mcp`](https://npmjs.com/package/@robot-resources/scraper-mcp)). The scraper fetches, extracts, and compresses the page into agent-friendly markdown — typically 80%+ fewer tokens than the raw HTML `web_fetch` would return.

The plugin is a thin tool-rewriter — it doesn't do any compression itself. The actual work happens in the scraper MCP server, which OC routes the rewritten call to.

## Install

Bundled with `npx robot-resources`. The wizard installs both this plugin and the router plugin into `~/.openclaw/extensions/` and registers them in `openclaw.json`.

Manual install:

```sh
npm install @robot-resources/scraper-oc-plugin
```

Then copy `node_modules/@robot-resources/scraper-oc-plugin/` to `~/.openclaw/extensions/robot-resources-scraper-oc-plugin/` and register it in `~/.openclaw/openclaw.json` under `plugins.entries` and `plugins.allow`.

## How the hook works

```
agent calls web_fetch(url)
  → plugin's before_tool_call fires (priority 10)
  → returns { toolOverride: 'scraper_compress_url', paramsOverride: { url, mode: 'auto' } }
  → OC dispatches scraper_compress_url(url, mode: 'auto') instead
  → @robot-resources/scraper-mcp fetches, extracts, compresses
  → agent sees compressed markdown
```

## Source

[github.com/robot-resources/packages](https://github.com/robot-resources/packages/tree/main/scraper/packages/scraper-oc-plugin)
