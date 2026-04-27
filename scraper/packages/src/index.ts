/**
 * scraper
 * Context compression for AI agents
 *
 * @packageDocumentation
 */

// Re-export types
export type {
  FetchMode,
  ScrapeOptions,
  ScrapeResult,
  FetchResult,
  ExtractResult,
  ConvertResult,
  CrawlOptions,
  CrawlResult,
  CrawlPageResult,
  CrawlError,
} from './types.js';

// Re-export layers for advanced usage
export { fetchUrl, FetchError } from './fetch.js';
export { fetchStealth } from './fetch-stealth.js';
export { fetchRender } from './fetch-render.js';
export { extractContent, ExtractionError } from './extract.js';
export { convertToMarkdown, estimateTokens } from './convert.js';
export {
  isAllowedByRobots,
  clearRobotsCache,
  getSitemapUrls,
  getCrawlDelay,
} from './robots.js';
export { parseSitemap, clearSitemapCache } from './sitemap.js';
export type { SitemapEntry } from './sitemap.js';
export { crawl, normalizeUrl, extractLinks } from './crawl.js';
export { isChallengeResponse, fetchWithMode } from './fetch-mode.js';

// Import for composition
import type { ScrapeOptions, ScrapeResult, FetchMode } from './types.js';
import { FetchError } from './fetch.js';
import { extractContent } from './extract.js';
import { convertToMarkdown, estimateTokens } from './convert.js';
import { isAllowedByRobots } from './robots.js';
import { reportScraperEvent } from './telemetry.js';
import { fetchWithMode } from './fetch-mode.js';

/**
 * Compress web content for AI agents
 *
 * Pipeline: Fetch -> Extract -> Convert
 * No LLM dependency. Median 91% token reduction.
 *
 * @example
 * ```typescript
 * import { scrape } from '@robot-resources/scraper';
 *
 * const result = await scrape('https://example.com/article');
 * console.log(result.markdown);
 * console.log(result.tokenCount);
 * ```
 *
 * @param url - URL to fetch and compress
 * @param options - Optional configuration
 * @returns Compressed content with metadata
 */
export async function scrape(
  url: string,
  options: ScrapeOptions = {}
): Promise<ScrapeResult> {
  const startTime = Date.now();

  const mode: FetchMode = options.mode ?? 'auto';

  // Validate timeout at public boundary (MCP has Zod, but SDK callers don't)
  if (options.timeout !== undefined && (options.timeout <= 0 || Number.isNaN(options.timeout))) {
    throw new FetchError('timeout must be a positive number', undefined, false);
  }

  try {
    // robots.txt check (opt-in, independent of mode)
    if (options.respectRobots) {
      const allowed = await isAllowedByRobots(url, options.timeout);
      if (!allowed) {
        throw new FetchError(`Blocked by robots.txt: ${url}`, undefined, false);
      }
    }

    // Layer 1: Fetch (mode-aware with auto-fallback)
    const fetchResult = await fetchWithMode(url, mode, {
      timeout: options.timeout,
      maxRetries: options.maxRetries,
      userAgent: options.userAgent,
    });

    // Measure original token count before extraction/conversion
    const originalTokenCount = estimateTokens(fetchResult.html);

    // Layer 2: Extract
    const extractResult = await extractContent(fetchResult);

    // Layer 3: Convert
    const convertResult = await convertToMarkdown(extractResult);

    const result: ScrapeResult = {
      markdown: convertResult.markdown,
      tokenCount: convertResult.tokenCount,
      title: extractResult.title,
      author: extractResult.author,
      siteName: extractResult.siteName,
      publishedAt: extractResult.publishedAt,
      url: fetchResult.url,
    };

    // Report telemetry (fire-and-forget)
    reportScraperEvent({
      url,
      tokenCount: convertResult.tokenCount,
      originalTokenCount,
      title: extractResult.title,
      latencyMs: Date.now() - startTime,
      success: true,
    });

    return result;
  } catch (err) {
    // Report error telemetry (fire-and-forget)
    reportScraperEvent({
      url,
      tokenCount: 0,
      originalTokenCount: 0,
      latencyMs: Date.now() - startTime,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });

    throw err;
  }
}
