import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
  isAllowedByRobots,
  clearRobotsCache,
  getSitemapUrls,
  getCrawlDelay,
} from '../robots.js';

function robotsResponse(body: string, status = 200) {
  return Promise.resolve(new Response(body, { status }));
}

describe('isAllowedByRobots', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearRobotsCache();
    mockFetch.mockReset();
  });

  it('returns true when URL is allowed', async () => {
    mockFetch.mockReturnValueOnce(
      robotsResponse('User-agent: *\nDisallow: /admin/')
    );

    const allowed = await isAllowedByRobots('https://example.com/blog/post');
    expect(allowed).toBe(true);
  });

  it('returns false when URL is disallowed', async () => {
    mockFetch.mockReturnValueOnce(
      robotsResponse('User-agent: *\nDisallow: /private/')
    );

    const allowed = await isAllowedByRobots('https://example.com/private/secret');
    expect(allowed).toBe(false);
  });

  it('returns false when all paths are disallowed', async () => {
    mockFetch.mockReturnValueOnce(
      robotsResponse('User-agent: *\nDisallow: /')
    );

    const allowed = await isAllowedByRobots('https://example.com/anything');
    expect(allowed).toBe(false);
  });

  it('returns true when robots.txt returns 404 (fail-open)', async () => {
    mockFetch.mockReturnValueOnce(
      robotsResponse('Not Found', 404)
    );

    const allowed = await isAllowedByRobots('https://example.com/page');
    expect(allowed).toBe(true);
  });

  it('returns true when robots.txt fetch fails (fail-open)', async () => {
    mockFetch.mockReturnValueOnce(
      Promise.reject(new Error('Network error'))
    );

    const allowed = await isAllowedByRobots('https://example.com/page');
    expect(allowed).toBe(true);
  });

  it('returns true when robots.txt fetch times out (fail-open)', async () => {
    mockFetch.mockReturnValueOnce(
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('AbortError')), 100)
      )
    );

    const allowed = await isAllowedByRobots('https://example.com/page', 50);
    expect(allowed).toBe(true);
  });

  describe('caching', () => {
    it('caches robots.txt per domain — second call does not re-fetch', async () => {
      mockFetch.mockReturnValue(
        robotsResponse('User-agent: *\nDisallow: /admin/')
      );

      await isAllowedByRobots('https://example.com/page1');
      await isAllowedByRobots('https://example.com/page2');

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('fetches separately for different domains', async () => {
      mockFetch.mockReturnValue(
        robotsResponse('User-agent: *\nAllow: /')
      );

      await isAllowedByRobots('https://example.com/page');
      await isAllowedByRobots('https://other.com/page');

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('clearRobotsCache resets the cache', async () => {
      mockFetch.mockReturnValue(
        robotsResponse('User-agent: *\nAllow: /')
      );

      await isAllowedByRobots('https://example.com/page');
      clearRobotsCache();
      await isAllowedByRobots('https://example.com/page');

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('ScraperBot-specific rules', () => {
    it('respects ScraperBot-specific disallow rules', async () => {
      mockFetch.mockReturnValueOnce(
        robotsResponse(
          'User-agent: ScraperBot\nDisallow: /blocked/\n\nUser-agent: *\nAllow: /'
        )
      );

      const allowed = await isAllowedByRobots('https://example.com/blocked/page');
      expect(allowed).toBe(false);
    });

    it('allows paths not disallowed for ScraperBot', async () => {
      mockFetch.mockReturnValueOnce(
        robotsResponse(
          'User-agent: ScraperBot\nDisallow: /blocked/\n\nUser-agent: *\nDisallow: /'
        )
      );

      const allowed = await isAllowedByRobots('https://example.com/open/page');
      expect(allowed).toBe(true);
    });
  });
});

// ============================================
// getSitemapUrls — TKT-SCRAPER-078
// ============================================

describe('getSitemapUrls', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearRobotsCache();
    mockFetch.mockReset();
  });

  it('extracts Sitemap URLs from robots.txt', async () => {
    mockFetch.mockReturnValueOnce(
      robotsResponse(
        'User-agent: *\nDisallow: /admin/\nSitemap: https://example.com/sitemap.xml\nSitemap: https://example.com/sitemap2.xml'
      )
    );

    const sitemaps = await getSitemapUrls('https://example.com/page');

    expect(sitemaps).toEqual([
      'https://example.com/sitemap.xml',
      'https://example.com/sitemap2.xml',
    ]);
  });

  it('returns empty array when no Sitemap directives', async () => {
    mockFetch.mockReturnValueOnce(
      robotsResponse('User-agent: *\nDisallow: /admin/')
    );

    const sitemaps = await getSitemapUrls('https://example.com/page');

    expect(sitemaps).toEqual([]);
  });

  it('returns empty array when robots.txt returns 404 (fail-open)', async () => {
    mockFetch.mockReturnValueOnce(robotsResponse('Not Found', 404));

    const sitemaps = await getSitemapUrls('https://example.com/page');

    expect(sitemaps).toEqual([]);
  });

  it('returns empty array when fetch fails with network error (fail-open)', async () => {
    mockFetch.mockReturnValueOnce(Promise.reject(new Error('Network error')));

    const sitemaps = await getSitemapUrls('https://example.com/page');

    expect(sitemaps).toEqual([]);
  });

  it('uses cached robots.txt (no re-fetch on second call)', async () => {
    mockFetch.mockReturnValue(
      robotsResponse(
        'User-agent: *\nSitemap: https://example.com/sitemap.xml'
      )
    );

    await getSitemapUrls('https://example.com/page');
    const sitemaps = await getSitemapUrls('https://example.com/other');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(sitemaps).toEqual(['https://example.com/sitemap.xml']);
  });
});

// ============================================
// getCrawlDelay — TKT-SCRAPER-078
// ============================================

describe('getCrawlDelay', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearRobotsCache();
    mockFetch.mockReset();
  });

  it('extracts Crawl-delay value from robots.txt', async () => {
    mockFetch.mockReturnValueOnce(
      robotsResponse('User-agent: *\nCrawl-delay: 5\nDisallow: /admin/')
    );

    const delay = await getCrawlDelay('https://example.com/page');

    expect(delay).toBe(5);
  });

  it('returns null when no Crawl-delay directive', async () => {
    mockFetch.mockReturnValueOnce(
      robotsResponse('User-agent: *\nDisallow: /admin/')
    );

    const delay = await getCrawlDelay('https://example.com/page');

    expect(delay).toBeNull();
  });

  it('returns Crawl-delay: 0 correctly', async () => {
    mockFetch.mockReturnValueOnce(
      robotsResponse('User-agent: *\nCrawl-delay: 0')
    );

    const delay = await getCrawlDelay('https://example.com/page');

    expect(delay).toBe(0);
  });

  it('returns null when robots.txt returns 404 (fail-open)', async () => {
    mockFetch.mockReturnValueOnce(robotsResponse('Not Found', 404));

    const delay = await getCrawlDelay('https://example.com/page');

    expect(delay).toBeNull();
  });

  it('returns null when fetch fails with network error (fail-open)', async () => {
    mockFetch.mockReturnValueOnce(Promise.reject(new Error('Network error')));

    const delay = await getCrawlDelay('https://example.com/page');

    expect(delay).toBeNull();
  });

  it('uses cached robots.txt (no re-fetch on second call)', async () => {
    mockFetch.mockReturnValue(
      robotsResponse('User-agent: *\nCrawl-delay: 10')
    );

    await getCrawlDelay('https://example.com/page');
    const delay = await getCrawlDelay('https://example.com/other');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(delay).toBe(10);
  });
});
