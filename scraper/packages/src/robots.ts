/**
 * robots.txt compliance layer
 *
 * Opt-in for single-page scraping (respectRobots option),
 * foundation for FTR-ORG-019 crawl mode where it becomes default.
 */

import robotsParser from 'robots-parser';

interface RobotsCacheEntry {
  parser: ReturnType<typeof robotsParser>;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_TIMEOUT_MS = 5000;
const BOT_USER_AGENT = 'ScraperBot';

const cache = new Map<string, RobotsCacheEntry>();

function getRobotsUrl(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}/robots.txt`;
}

async function getRobotsParser(
  url: string,
  timeout: number = DEFAULT_TIMEOUT_MS
): Promise<ReturnType<typeof robotsParser>> {
  const robotsUrl = getRobotsUrl(url);

  const cached = cache.get(robotsUrl);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.parser;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(robotsUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': BOT_USER_AGENT },
    });

    clearTimeout(timeoutId);

    const text = response.ok ? await response.text() : '';
    const parser = robotsParser(robotsUrl, text);

    cache.set(robotsUrl, {
      parser,
      expiresAt: Date.now() + DEFAULT_TTL_MS,
    });

    return parser;
  } catch {
    // Fail-open: if robots.txt is unreachable, allow everything
    const parser = robotsParser(robotsUrl, '');
    cache.set(robotsUrl, {
      parser,
      expiresAt: Date.now() + DEFAULT_TTL_MS,
    });
    return parser;
  }
}

/**
 * Check if a URL is allowed by robots.txt.
 * Returns true if allowed or if robots.txt cannot be fetched (fail-open).
 */
export async function isAllowedByRobots(
  url: string,
  timeout?: number
): Promise<boolean> {
  const parser = await getRobotsParser(url, timeout);
  return parser.isAllowed(url, BOT_USER_AGENT) !== false;
}

/**
 * Extract Sitemap: URLs from robots.txt.
 * Returns empty array if no Sitemap directives or robots.txt unreachable (fail-open).
 * Reuses cached robots.txt parser.
 */
export async function getSitemapUrls(
  url: string,
  timeout?: number
): Promise<string[]> {
  const parser = await getRobotsParser(url, timeout);
  return parser.getSitemaps();
}

/**
 * Extract Crawl-delay value from robots.txt for ScraperBot user agent.
 * Returns delay in seconds, or null if not specified or robots.txt unreachable (fail-open).
 * Reuses cached robots.txt parser.
 */
export async function getCrawlDelay(
  url: string,
  timeout?: number
): Promise<number | null> {
  const parser = await getRobotsParser(url, timeout);
  const delay = parser.getCrawlDelay(BOT_USER_AGENT);
  return delay === undefined ? null : delay;
}

/**
 * Clear the robots.txt cache. Exported for testing.
 */
export function clearRobotsCache(): void {
  cache.clear();
}
