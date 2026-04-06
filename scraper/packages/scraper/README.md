[![CI](https://github.com/robot-resources/scraper/actions/workflows/ci.yml/badge.svg)](https://github.com/robot-resources/scraper/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@robot-resources/scraper)](https://www.npmjs.com/package/@robot-resources/scraper)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/robot-resources/scraper/blob/main/LICENSE)
[![npm downloads](https://img.shields.io/npm/dm/@robot-resources/scraper)](https://www.npmjs.com/package/@robot-resources/scraper)
[![codecov](https://codecov.io/gh/robot-resources/scraper/branch/main/graph/badge.svg)](https://codecov.io/gh/robot-resources/scraper)
[![bundle size](https://img.shields.io/bundlephobia/minzip/@robot-resources/scraper)](https://bundlephobia.com/package/@robot-resources/scraper)

# @robot-resources/scraper

> Context compression for AI agents. Fetch → Extract → Convert pipeline without LLM dependency.

Median 91% token reduction for AI agent consumption (verified across 41 page types). 3-tier fetch with auto-fallback, BFS multi-page crawl, robots.txt compliance.

## Installation

```bash
npm install @robot-resources/scraper
```

**Optional peer dependencies** (install only what you need):

```bash
npm install impit          # Stealth mode — TLS fingerprint impersonation
npm install playwright     # Render mode — headless browser for JS-rendered pages
```

## Quick Start

```typescript
import { scrape } from '@robot-resources/scraper';

const result = await scrape('https://example.com/article');

console.log(result.markdown);     // Compressed content
console.log(result.tokenCount);   // Estimated tokens
console.log(result.title);        // Page title
```

## Fetch Modes

Control how pages are fetched with the `mode` option:

| Mode | How | When to use |
|------|-----|-------------|
| `'fast'` | Plain HTTP fetch | Default sites, APIs, docs |
| `'stealth'` | TLS fingerprint impersonation (impit) | Sites with anti-bot protection |
| `'render'` | Headless Playwright browser | JS-rendered SPAs, dynamic content |
| `'auto'` | Fast first, falls back to stealth on 403/challenge | **Default** — best for unknown sites |

```typescript
// Explicit stealth for a protected site
const result = await scrape('https://protected-site.com', { mode: 'stealth' });

// Auto mode (default) — tries fast, falls back to stealth if blocked
const result = await scrape('https://unknown-site.com');
```

## Crawling Multiple Pages

```typescript
import { crawl } from '@robot-resources/scraper';

const result = await crawl({
  url: 'https://docs.example.com',
  depth: 2,            // Max link depth (default: 2)
  limit: 20,           // Max pages (default: 50)
  mode: 'auto',        // Fetch mode per page
  concurrency: 3,      // Parallel fetches (default: 3)
  respectRobots: true,  // Obey robots.txt (default: true)
  include: ['**/docs/**'],   // Only crawl docs paths
  exclude: ['**/archive/**'], // Skip archive
});

console.log(`Crawled ${result.totalCrawled} pages in ${result.duration}ms`);

for (const page of result.pages) {
  console.log(`[depth ${page.depth}] ${page.title}: ${page.tokenCount} tokens`);
}
```

The crawler uses BFS link discovery, seeds from sitemap.xml when available, and respects crawl-delay from robots.txt.

## API

### `scrape(url, options?)`

Fetch a URL and return compressed markdown.

```typescript
const result = await scrape('https://example.com', {
  mode: 'auto',          // Fetch mode (default: 'auto')
  timeout: 5000,         // Request timeout ms (default: 10000)
  maxRetries: 2,         // Retry attempts (default: 3)
  userAgent: '...',      // Custom user agent
  respectRobots: false,  // Check robots.txt (default: false)
});
```

**Returns:** `ScrapeResult`

```typescript
interface ScrapeResult {
  markdown: string;      // Compressed content
  tokenCount: number;    // Estimated token count
  title?: string;        // Page title
  author?: string;       // Author if found
  siteName?: string;     // Site name if found
  publishedAt?: string;  // Publish date if found
  url: string;           // Final URL after redirects
}
```

### `crawl(options)`

BFS multi-page crawl from a starting URL.

```typescript
const result = await crawl({
  url: 'https://example.com',   // Starting URL (required)
  depth: 2,                     // Max depth (default: 2)
  limit: 50,                    // Max pages (default: 50)
  mode: 'auto',                 // Fetch mode (default: 'auto')
  include: ['**/blog/**'],      // Include patterns (glob)
  exclude: ['**/admin/**'],     // Exclude patterns (glob)
  timeout: 10000,               // Per-page timeout ms
  concurrency: 3,               // Parallel fetches (default: 3)
  respectRobots: true,          // Obey robots.txt (default: true)
});
```

**Returns:** `CrawlResult`

```typescript
interface CrawlResult {
  pages: CrawlPageResult[];  // Scraped pages (extends ScrapeResult + depth)
  totalDiscovered: number;   // Total URLs found
  totalCrawled: number;      // Successfully scraped
  totalSkipped: number;      // Skipped (robots, filter, limit)
  errors: CrawlError[];      // Per-URL errors
  duration: number;          // Total ms
}
```

### Individual Layers

For advanced usage, use the pipeline layers directly:

```typescript
import {
  fetchUrl,
  fetchStealth,
  fetchRender,
  extractContent,
  convertToMarkdown,
  estimateTokens,
} from '@robot-resources/scraper';

// Layer 1: Fetch HTML (choose your tier)
const fetched = await fetchUrl('https://example.com');
// or: await fetchStealth(url, options)
// or: await fetchRender(url, options)

// Layer 2: Extract main content
const extracted = await extractContent(fetched);

// Layer 3: Convert to markdown
const converted = await convertToMarkdown(extracted);

// Token estimation
const htmlTokens = estimateTokens(fetched.html);
console.log(`Compressed ${htmlTokens} → ${converted.tokenCount} tokens`);
```

### Robots & Sitemap

```typescript
import {
  isAllowedByRobots,
  getCrawlDelay,
  getSitemapUrls,
  parseSitemap,
} from '@robot-resources/scraper';

const allowed = await isAllowedByRobots('https://example.com/page');
const delay = await getCrawlDelay('https://example.com');
const entries = await parseSitemap('https://example.com/sitemap.xml');
```

### Error Handling

```typescript
import { scrape, FetchError, ExtractionError } from '@robot-resources/scraper';

try {
  const result = await scrape(url);
} catch (error) {
  if (error instanceof FetchError) {
    console.log('Fetch failed:', error.statusCode, error.retryable);
  }
  if (error instanceof ExtractionError) {
    console.log('Extraction failed:', error.code);
  }
}
```

## Token Reduction

Verified across 41 pages (March 2026):

| Page Type | HTML Tokens | Scraper Tokens | Reduction |
|-----------|-------------|----------------|-----------|
| Landing pages & SPAs | ~237,000 | ~380 | 99% |
| GitHub repositories | ~110,000 | ~479 | 99% |
| API reference (MDN) | ~55,000 | ~6,349 | 88% |
| Wikipedia articles | ~187,000 | ~42,039 | 77% |
| Blog posts & essays | ~20,000 | ~15,639 | 22-92% |
| **Median across all types** | | | **91%** |

## Requirements

- Node.js 18+
- ESM or CommonJS

## Related

- [@robot-resources/scraper-mcp](https://npm.im/@robot-resources/scraper-mcp) - MCP server for AI agents
- [@robot-resources/scraper-tracking](https://npm.im/@robot-resources/scraper-tracking) - Usage tracking
- [scraper.robotresources.ai](https://scraper.robotresources.ai) - Hosted API
- [Robot Resources](https://robotresources.ai) - Human Resources, but for your AI agents

## License

MIT
