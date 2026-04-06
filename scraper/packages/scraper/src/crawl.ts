/**
 * Crawl: BFS multi-page orchestrator
 * TKT-SCRAPER-079: Crawl multiple pages from a starting URL
 *
 * Composes: sitemap seeding, robots.txt, link extraction, URL normalization,
 * depth/limit/filter constraints, concurrency, and scrape pipeline per page.
 */

import type {
  CrawlOptions,
  CrawlResult,
  CrawlPageResult,
  CrawlError,
} from './types.js';
import { FetchError } from './fetch.js';
import { extractContent } from './extract.js';
import { convertToMarkdown } from './convert.js';
import { isAllowedByRobots, getCrawlDelay } from './robots.js';
import { parseSitemap } from './sitemap.js';
import { fetchWithMode } from './fetch-mode.js';

// ============================================
// URL utilities
// ============================================

function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    let pathname = parsed.pathname;
    if (pathname.length > 1 && pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1);
    }
    parsed.pathname = pathname;
    return parsed.toString();
  } catch {
    return url;
  }
}

const SKIP_EXTENSIONS = new Set([
  '.pdf', '.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.ico',
  '.mp4', '.mp3', '.wav', '.avi',
  '.zip', '.tar', '.gz', '.rar',
  '.css', '.js', '.xml', '.json', '.woff', '.woff2', '.ttf', '.eot',
]);

export function extractLinks(html: string, baseUrl: string): string[] {
  const links: string[] = [];
  let origin: string;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    return [];
  }

  const regex = /<a\s+[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const href = match[1].trim();
    if (
      href.startsWith('mailto:') ||
      href.startsWith('tel:') ||
      href.startsWith('javascript:') ||
      href.startsWith('#')
    ) continue;

    try {
      const resolved = new URL(href, baseUrl);
      if (resolved.origin !== origin) continue;

      const ext = resolved.pathname.toLowerCase().match(/\.\w+$/)?.[0];
      if (ext && SKIP_EXTENSIONS.has(ext)) continue;

      links.push(normalizeUrl(resolved.toString()));
    } catch {
      // Invalid URL, skip
    }
  }

  return [...new Set(links)];
}

// ============================================
// URL filtering
// ============================================

function matchGlob(url: string, pattern: string): boolean {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '{{DOUBLESTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\{\{DOUBLESTAR\}\}/g, '.*');
  return new RegExp(regex).test(url);
}

function matchesFilter(url: string, include?: string[], exclude?: string[]): boolean {
  if (exclude?.length) {
    for (const pattern of exclude) {
      if (matchGlob(url, pattern)) return false;
    }
  }
  if (include?.length) {
    return include.some(pattern => matchGlob(url, pattern));
  }
  return true;
}

// ============================================
// Crawl
// ============================================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function crawl(options: CrawlOptions): Promise<CrawlResult> {
  const startTime = Date.now();

  const {
    url: startUrl,
    depth: maxDepth = 2,
    limit = 50,
    mode = 'auto',
    include,
    exclude,
    timeout,
    concurrency = 3,
    respectRobots = true,
  } = options;

  // Validation
  if (!isValidUrl(startUrl)) {
    throw new FetchError('Invalid URL', undefined, false);
  }
  if (maxDepth < 0) throw new FetchError('depth must be >= 0', undefined, false);
  if (limit < 1) throw new FetchError('limit must be >= 1', undefined, false);
  if (concurrency < 1) throw new FetchError('concurrency must be >= 1', undefined, false);
  if (timeout !== undefined && (timeout <= 0 || Number.isNaN(timeout))) {
    throw new FetchError('timeout must be a positive number', undefined, false);
  }

  const pages: CrawlPageResult[] = [];
  const errors: CrawlError[] = [];
  const visited = new Set<string>();
  let totalDiscovered = 0;
  let totalSkipped = 0;

  const normalizedStart = normalizeUrl(startUrl);
  const origin = new URL(startUrl).origin;

  // Robots.txt + crawl delay
  let crawlDelay: number | null = null;
  if (respectRobots) {
    crawlDelay = await getCrawlDelay(startUrl, timeout);
    const allowed = await isAllowedByRobots(startUrl, timeout);
    if (!allowed) {
      return {
        pages: [],
        totalDiscovered: 1,
        totalCrawled: 0,
        totalSkipped: 1,
        errors: [],
        duration: Date.now() - startTime,
      };
    }
  }

  // Seed: start URL + sitemap URLs
  const queue: Array<{ url: string; depth: number }> = [
    { url: normalizedStart, depth: 0 },
  ];

  if (maxDepth > 0) {
    try {
      const sitemapEntries = await parseSitemap(`${origin}/sitemap.xml`, timeout);
      const seen = new Set<string>([normalizedStart]);
      for (const entry of sitemapEntries) {
        const normalized = normalizeUrl(entry.loc);
        if (!seen.has(normalized)) {
          seen.add(normalized);
          queue.push({ url: normalized, depth: 1 });
        }
      }
    } catch (err) {
      console.debug(`[scraper] Sitemap unavailable for ${origin}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  totalDiscovered = queue.length;

  // BFS loop
  while (queue.length > 0 && pages.length < limit) {
    const batchSize = Math.min(concurrency, limit - pages.length, queue.length);
    const batch = queue.splice(0, batchSize);

    const tasks = batch.map(async ({ url, depth }) => {
      const normalized = normalizeUrl(url);

      if (visited.has(normalized)) {
        totalSkipped++;
        return;
      }
      visited.add(normalized);

      // URL filter check (start URL is exempt — it's the user's explicit seed)
      if (normalized !== normalizedStart && !matchesFilter(normalized, include, exclude)) {
        totalSkipped++;
        return;
      }

      // Per-URL robots check
      if (respectRobots) {
        const allowed = await isAllowedByRobots(url, timeout);
        if (!allowed) {
          totalSkipped++;
          return;
        }
      }

      try {
        const fetchResult = await fetchWithMode(url, mode, { timeout });
        const extractResult = await extractContent(fetchResult);
        const convertResult = await convertToMarkdown(extractResult);

        const pageResult: CrawlPageResult = {
          markdown: convertResult.markdown,
          tokenCount: convertResult.tokenCount,
          title: extractResult.title,
          author: extractResult.author,
          siteName: extractResult.siteName,
          publishedAt: extractResult.publishedAt,
          url: fetchResult.url,
          depth,
        };

        pages.push(pageResult);

        // Extract links for next depth level
        if (depth < maxDepth) {
          const links = extractLinks(fetchResult.html, fetchResult.url);
          for (const link of links) {
            if (!visited.has(link)) {
              queue.push({ url: link, depth: depth + 1 });
              totalDiscovered++;
            }
          }
        }
      } catch (err) {
        errors.push({
          url,
          error: err instanceof Error ? err.message : String(err),
          depth,
        });
      }
    });

    await Promise.allSettled(tasks);

    // Crawl delay between batches
    if (crawlDelay && crawlDelay > 0 && queue.length > 0) {
      await sleep(crawlDelay * 1000);
    }
  }

  return {
    pages,
    totalDiscovered,
    totalCrawled: pages.length,
    totalSkipped,
    errors,
    duration: Date.now() - startTime,
  };
}
