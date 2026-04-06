/**
 * scraper-mcp server
 * MCP server wrapping @robot-resources/scraper
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  fetchWithMode,
  extractContent,
  convertToMarkdown,
  estimateTokens,
  crawl,
  FetchError,
  ExtractionError,
} from '@robot-resources/scraper';
import type { FetchMode } from '@robot-resources/scraper';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'scraper-mcp',
    version: '0.1.0',
  });

  server.tool(
    'scraper_compress_url',
    'Compress web content from a URL for reduced token usage. Returns markdown with 70-90% fewer tokens than raw HTML.',
    {
      url: z.string().url().describe('URL to compress'),
      mode: z
        .enum(['fast', 'stealth', 'render', 'auto'])
        .optional()
        .describe("Fetch mode: 'fast' (plain HTTP), 'stealth' (TLS fingerprint), 'render' (headless browser), 'auto' (fast with fallback). Default: 'auto'"),
      timeout: z
        .number()
        .positive()
        .optional()
        .describe('Fetch timeout in milliseconds (default: 10000)'),
      maxRetries: z
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .describe('Max retry attempts (default: 3)'),
    },
    async (args) => compressUrl(args),
  );

  server.tool(
    'scraper_crawl_url',
    'Crawl multiple pages from a starting URL using BFS link discovery. Returns compressed markdown for each page with 70-90% fewer tokens than raw HTML.',
    {
      url: z.string().url().describe('Starting URL to crawl'),
      maxPages: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('Max pages to crawl (default: 10)'),
      maxDepth: z
        .number()
        .int()
        .min(0)
        .max(5)
        .optional()
        .describe('Max link depth (default: 2)'),
      mode: z
        .enum(['fast', 'stealth', 'render', 'auto'])
        .optional()
        .describe("Fetch mode: 'fast' (plain HTTP), 'stealth' (TLS fingerprint), 'render' (headless browser), 'auto' (fast with fallback). Default: 'auto'"),
      include: z
        .array(z.string())
        .optional()
        .describe('URL patterns to include (glob)'),
      exclude: z
        .array(z.string())
        .optional()
        .describe('URL patterns to exclude (glob)'),
      timeout: z
        .number()
        .positive()
        .optional()
        .describe('Per-page timeout in milliseconds (default: 10000)'),
    },
    async (args) => crawlUrl(args),
  );

  return server;
}

export async function compressUrl({
  url,
  mode,
  timeout,
  maxRetries,
}: {
  url: string;
  mode?: FetchMode;
  timeout?: number;
  maxRetries?: number;
}) {
  try {
    const fetchResult = await fetchWithMode(url, mode ?? 'auto', { timeout, maxRetries });
    const originalTokens = estimateTokens(fetchResult.html);
    const extractResult = await extractContent(fetchResult);
    const convertResult = await convertToMarkdown(extractResult);

    const compressionRatio =
      originalTokens > 0
        ? Math.round((1 - convertResult.tokenCount / originalTokens) * 100)
        : 0;

    return {
      content: [{ type: 'text' as const, text: convertResult.markdown }],
      structuredContent: {
        markdown: convertResult.markdown,
        tokenCount: convertResult.tokenCount,
        title: extractResult.title ?? null,
        author: extractResult.author ?? null,
        siteName: extractResult.siteName ?? null,
        url: fetchResult.url,
        compressionRatio,
      },
    };
  } catch (error) {
    return formatError(url, error);
  }
}

export async function crawlUrl({
  url,
  maxPages,
  maxDepth,
  mode,
  include,
  exclude,
  timeout,
}: {
  url: string;
  maxPages?: number;
  maxDepth?: number;
  mode?: FetchMode;
  include?: string[];
  exclude?: string[];
  timeout?: number;
}) {
  try {
    const result = await crawl({
      url,
      limit: maxPages ?? 10,
      depth: maxDepth ?? 2,
      mode,
      include,
      exclude,
      timeout,
    });

    const host = new URL(url).host;
    const errorSuffix = result.errors.length > 0
      ? ` (${result.errors.length} error${result.errors.length > 1 ? 's' : ''})`
      : '';
    const summary = `Crawled ${result.totalCrawled} pages from ${host}${errorSuffix}`;

    const content: Array<{ type: 'text'; text: string }> = [
      { type: 'text' as const, text: summary },
    ];

    for (const page of result.pages) {
      const header = page.title ? `## ${page.title}\n\n` : '';
      content.push({
        type: 'text' as const,
        text: `${header}${page.markdown}`,
      });
    }

    return {
      content,
      structuredContent: {
        pages: result.pages,
        totalCrawled: result.totalCrawled,
        totalDiscovered: result.totalDiscovered,
        totalSkipped: result.totalSkipped,
        errors: result.errors,
        duration: result.duration,
      },
    };
  } catch (error) {
    return formatError(url, error);
  }
}

export function formatError(url: string, error: unknown) {
  if (error instanceof FetchError) {
    let message: string;

    if (error.statusCode === 403) {
      message = `Access denied (HTTP 403) for ${url}. The site may block automated access. Try a different URL or check if authentication is required.`;
    } else if (error.statusCode === 404) {
      message = `Page not found (HTTP 404) at ${url}. Verify the URL is correct and the page exists.`;
    } else if (error.statusCode && error.statusCode >= 500) {
      message = `Server error (HTTP ${error.statusCode}) from ${url}. The site may be experiencing issues. Try again later.`;
    } else if (
      error.message.includes('timeout') ||
      error.message.includes('Timeout')
    ) {
      message = `Request timed out fetching ${url}. Try increasing the timeout parameter or check if the site is accessible.`;
    } else if (error.message.includes('Invalid URL')) {
      message = `Invalid URL: ${url}. Provide a full URL starting with http:// or https://`;
    } else {
      message = `Failed to fetch ${url}: ${error.message}${error.retryable ? '. Retries exhausted — try again later.' : ''}`;
    }

    return {
      content: [{ type: 'text' as const, text: message }],
      isError: true,
    };
  }

  if (error instanceof ExtractionError) {
    let message: string;

    if (error.code === 'EMPTY_HTML') {
      message = `The page at ${url} returned empty HTML. It may require JavaScript rendering — try using mode: 'render' (requires Playwright peer dependency) or try a URL that serves static HTML content.`;
    } else if (error.code === 'NO_CONTENT') {
      message = `Could not extract meaningful content from ${url}. The page may be a login wall, contain only images/video, or rely entirely on JavaScript rendering.`;
    } else {
      message = `Content extraction failed for ${url}: ${error.message}`;
    }

    return {
      content: [{ type: 'text' as const, text: message }],
      isError: true,
    };
  }

  const msg = error instanceof Error ? error.message : String(error);
  return {
    content: [
      {
        type: 'text' as const,
        text: `Unexpected error processing ${url}: ${msg}`,
      },
    ],
    isError: true,
  };
}
