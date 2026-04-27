/**
 * Sitemap parser
 *
 * Fetches and parses sitemap.xml for crawl mode seed URLs.
 * Regex-based XML parsing — no XML parser dependency.
 * Handles sitemap index files with recursion limit.
 * Mirrors robots.ts fetch+cache+fail-open pattern.
 */

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_RECURSION_DEPTH = 2;

/**
 * A single entry from a sitemap
 */
export interface SitemapEntry {
  /** URL from <loc> tag */
  loc: string;
  /** Last modification date from <lastmod> tag */
  lastmod?: string;
  /** Priority from <priority> tag (0.0 to 1.0) */
  priority?: number;
}

interface SitemapCacheEntry {
  entries: SitemapEntry[];
  expiresAt: number;
}

const cache = new Map<string, SitemapCacheEntry>();

/**
 * Extract origin (protocol + host) from URL
 */
function getOrigin(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}`;
}

/**
 * Check if XML contains a sitemap index
 */
function isSitemapIndex(xml: string): boolean {
  return /<sitemapindex[\s>]/i.test(xml);
}

/**
 * Extract sitemap URLs from a sitemap index
 * Handles namespace prefixes: <ns:loc>, <sitemap:loc>, etc.
 */
function extractSitemapIndexUrls(xml: string): string[] {
  const urls: string[] = [];
  // Match <sitemap>...</sitemap> blocks, then extract <loc> from each
  const sitemapBlockRegex = /<(?:\w+:)?sitemap\b[^>]*>([\s\S]*?)<\/(?:\w+:)?sitemap>/gi;
  let blockMatch;

  while ((blockMatch = sitemapBlockRegex.exec(xml)) !== null) {
    const block = blockMatch[1];
    const locMatch = /<(?:\w+:)?loc\b[^>]*>([\s\S]*?)<\/(?:\w+:)?loc>/i.exec(block);
    if (locMatch) {
      const url = locMatch[1].trim();
      if (url) urls.push(url);
    }
  }

  return urls;
}

/**
 * Extract URL entries from a sitemap urlset
 * Handles namespace prefixes: <ns:url>, <ns:loc>, etc.
 */
function extractUrlEntries(xml: string, origin: string): SitemapEntry[] {
  const entries: SitemapEntry[] = [];
  // Match <url>...</url> blocks
  const urlBlockRegex = /<(?:\w+:)?url\b[^>]*>([\s\S]*?)<\/(?:\w+:)?url>/gi;
  let blockMatch;

  while ((blockMatch = urlBlockRegex.exec(xml)) !== null) {
    const block = blockMatch[1];

    // Extract <loc>
    const locMatch = /<(?:\w+:)?loc\b[^>]*>([\s\S]*?)<\/(?:\w+:)?loc>/i.exec(block);
    if (!locMatch) continue;

    const loc = locMatch[1].trim();
    if (!loc) continue;

    // Same-origin filter
    try {
      if (getOrigin(loc) !== origin) continue;
    } catch {
      continue; // Invalid URL — skip
    }

    const entry: SitemapEntry = { loc };

    // Extract optional <lastmod>
    const lastmodMatch = /<(?:\w+:)?lastmod\b[^>]*>([\s\S]*?)<\/(?:\w+:)?lastmod>/i.exec(block);
    if (lastmodMatch) {
      const lastmod = lastmodMatch[1].trim();
      if (lastmod) entry.lastmod = lastmod;
    }

    // Extract optional <priority>
    const priorityMatch = /<(?:\w+:)?priority\b[^>]*>([\s\S]*?)<\/(?:\w+:)?priority>/i.exec(block);
    if (priorityMatch) {
      const priority = parseFloat(priorityMatch[1].trim());
      if (!isNaN(priority)) entry.priority = priority;
    }

    entries.push(entry);
  }

  return entries;
}

/**
 * Fetch sitemap XML with timeout
 */
async function fetchSitemapXml(
  url: string,
  timeout: number
): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'ScraperBot/1.0' },
    });

    clearTimeout(timeoutId);

    if (!response.ok) return null;

    return await response.text();
  } catch {
    return null; // Fail-open
  }
}

/**
 * Internal recursive parser with depth tracking
 */
async function parseSitemapInternal(
  url: string,
  origin: string,
  timeout: number,
  depth: number
): Promise<SitemapEntry[]> {
  if (depth >= MAX_RECURSION_DEPTH) return [];

  const xml = await fetchSitemapXml(url, timeout);
  if (!xml) return [];

  // Check if this is a sitemap index
  if (isSitemapIndex(xml)) {
    const sitemapUrls = extractSitemapIndexUrls(xml);
    const allEntries: SitemapEntry[] = [];

    for (const sitemapUrl of sitemapUrls) {
      const entries = await parseSitemapInternal(
        sitemapUrl,
        origin,
        timeout,
        depth + 1
      );
      allEntries.push(...entries);
    }

    return allEntries;
  }

  // Regular sitemap — extract URL entries
  return extractUrlEntries(xml, origin);
}

/**
 * Parse a sitemap.xml and return URL entries.
 *
 * - Fetches the sitemap from the given URL
 * - Extracts <loc> URLs via regex (no XML parser dependency)
 * - Handles sitemap index files (recursive, max depth 2)
 * - Caches results per URL with 1-hour TTL
 * - Fail-open: returns empty array if sitemap is unreachable or invalid
 * - Filters to same-origin URLs only
 *
 * @param url - Full URL of the sitemap.xml
 * @param timeout - Fetch timeout in ms (default: 10000)
 * @returns Array of SitemapEntry objects
 */
export async function parseSitemap(
  url: string,
  timeout: number = DEFAULT_TIMEOUT_MS
): Promise<SitemapEntry[]> {
  // Check cache
  const cached = cache.get(url);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.entries;
  }

  let origin: string;
  try {
    origin = getOrigin(url);
  } catch {
    return []; // Invalid URL — fail-open
  }

  const entries = await parseSitemapInternal(url, origin, timeout, 0);

  // Cache the result
  cache.set(url, {
    entries,
    expiresAt: Date.now() + DEFAULT_TTL_MS,
  });

  return entries;
}

/**
 * Clear the sitemap cache. Exported for testing.
 */
export function clearSitemapCache(): void {
  cache.clear();
}
