/**
 * Types for scraper
 * Context compression for AI agents
 */

// ============================================
// Fetch Mode
// ============================================

/**
 * Fetch tier selection for scrape()
 *
 * - 'fast': Tier 1 — plain HTTP fetch (default Node.js fetch)
 * - 'stealth': Tier 2 — TLS fingerprint impersonation (bypasses anti-bot)
 * - 'render': Tier 3 — Playwright headless browser (JS-rendered pages)
 * - 'auto': Try fast first, fall back to stealth on 403/challenge detection
 */
export type FetchMode = 'fast' | 'stealth' | 'render' | 'auto';

/**
 * Options for the scrape() function
 */
export interface ScrapeOptions {
  /** Fetch tier to use (default: 'auto') */
  mode?: FetchMode;
  /** Request timeout in milliseconds (default: 10000) */
  timeout?: number;
  /** Maximum retry attempts for failed requests (default: 3) */
  maxRetries?: number;
  /** Custom user agent string */
  userAgent?: string;
  /** Check robots.txt before fetching (default: false) */
  respectRobots?: boolean;
}

/**
 * Result from the scrape() function
 */
export interface ScrapeResult {
  /** Compressed markdown content */
  markdown: string;
  /** Estimated token count */
  tokenCount: number;
  /** Page title if extracted */
  title?: string;
  /** Author if extracted */
  author?: string;
  /** Site name if extracted */
  siteName?: string;
  /** Published date if extracted */
  publishedAt?: string;
  /** Final URL after redirects */
  url: string;
}

/**
 * Result from fetch layer
 */
export interface FetchResult {
  /** Raw HTML content */
  html: string;
  /** Final URL after redirects */
  url: string;
  /** HTTP status code */
  statusCode: number;
  /** Response headers */
  headers: Record<string, string>;
}

/**
 * Result from extract layer
 */
export interface ExtractResult {
  /** Extracted HTML content (article body) */
  content: string;
  /** Page title */
  title?: string;
  /** Author name */
  author?: string;
  /** Published timestamp */
  publishedAt?: string;
  /** Site name */
  siteName?: string;
}

/**
 * Result from convert layer
 */
export interface ConvertResult {
  /** Markdown content */
  markdown: string;
  /** Estimated token count */
  tokenCount: number;
}

// ============================================
// Crawl Types
// ============================================

/**
 * Options for the crawl() function
 */
export interface CrawlOptions {
  /** Starting URL to crawl */
  url: string;
  /** Max crawl depth — 0 means only starting URL (default: 2) */
  depth?: number;
  /** Max pages to crawl (default: 50) */
  limit?: number;
  /** Fetch mode per page (default: 'auto') */
  mode?: FetchMode;
  /** URL patterns to include — glob-style (if set, URL must match at least one) */
  include?: string[];
  /** URL patterns to exclude — glob-style (URL must not match any) */
  exclude?: string[];
  /** Per-page timeout in milliseconds (default: 10000) */
  timeout?: number;
  /** Parallel page fetches (default: 3) */
  concurrency?: number;
  /** Check robots.txt before crawling (default: true) */
  respectRobots?: boolean;
}

/**
 * Result from a single crawled page — extends ScrapeResult with crawl depth
 */
export interface CrawlPageResult extends ScrapeResult {
  /** Crawl depth where this page was discovered */
  depth: number;
}

/**
 * Error for a single URL during crawl
 */
export interface CrawlError {
  /** URL that failed */
  url: string;
  /** Error message */
  error: string;
  /** Crawl depth where error occurred */
  depth: number;
}

/**
 * Aggregate result from crawl()
 */
export interface CrawlResult {
  /** Successfully scraped pages */
  pages: CrawlPageResult[];
  /** Total URLs discovered (including skipped/errored) */
  totalDiscovered: number;
  /** Total URLs successfully scraped */
  totalCrawled: number;
  /** Total URLs skipped (robots, filter, limit) */
  totalSkipped: number;
  /** Per-URL errors */
  errors: CrawlError[];
  /** Total crawl duration in milliseconds */
  duration: number;
}
