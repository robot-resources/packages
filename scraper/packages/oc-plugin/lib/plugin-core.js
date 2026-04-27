/**
 * Robot Resources scraper OC plugin — core implementation.
 *
 * Single hook: redirects OpenClaw's `web_fetch` tool calls to
 * `scraper_compress_url` (provided by @robot-resources/scraper-mcp).
 * Pure tool-rewrite — emits a toolOverride and lets OC's tool dispatcher
 * route the call to the scraper MCP server. Zero dependencies on the
 * scraper core lib.
 *
 * Lives as its own OC plugin (not co-located with the router plugin)
 * since PR 6 of the in-process refactor — see business/refactor-router-in-process.md.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEBUG = !!process.env.RR_DEBUG;
let _debugPath = null;

function logDecision(hook, data) {
  if (!DEBUG) return;
  try {
    if (!_debugPath) {
      const debugDir = join(homedir(), '.robot-resources', 'debug');
      mkdirSync(debugDir, { recursive: true });
      _debugPath = join(debugDir, 'scraper-plugin-decisions.jsonl');
    }
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      hook,
      ...data,
    });
    appendFileSync(_debugPath, entry + '\n');
  } catch { /* debug logging must never break the plugin */ }
}

const plugin = {
  id: 'robot-resources-scraper-oc-plugin',
  name: 'Robot Resources Scraper Hook',
  description: 'Redirects web_fetch tool calls to scraper_compress_url',

  register(api) {
    api.on('before_tool_call', async (event, _ctx) => {
      if (event.tool !== 'web_fetch') return;

      const url = event.params?.url;
      if (!url) return;

      api.logger.info(`[robot-resources] Redirecting web_fetch → scraper_compress_url: ${url}`);
      logDecision('before_tool_call', {
        original_tool: 'web_fetch',
        redirected_to: 'scraper_compress_url',
        url,
      });

      return {
        toolOverride: 'scraper_compress_url',
        paramsOverride: {
          url,
          mode: 'auto',
        },
      };
    }, { priority: 10 });
  },
};

export default plugin;
