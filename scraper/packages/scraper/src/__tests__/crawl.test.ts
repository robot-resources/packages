/**
 * crawl.ts tests
 * TKT-SCRAPER-079: Implement crawl() with BFS link discovery
 *
 * Tests cover: BFS traversal, depth/limit/concurrency, URL normalization,
 * link extraction, include/exclude filters, robots.txt, sitemap seeding,
 * error handling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FetchResult, ExtractResult } from '../types.js';

// ==============================
// Hoisted mocks
// ==============================

const {
  mockFetchUrl,
  mockFetchStealth,
  mockExtractContent,
  mockConvertToMarkdown,
  mockIsAllowedByRobots,
  mockGetCrawlDelay,
  mockParseSitemap,
  MockFetchError,
} = vi.hoisted(() => {
  class MockFetchError extends Error {
    constructor(
      message: string,
      public readonly statusCode?: number,
      public readonly retryable: boolean = false,
    ) {
      super(message);
      this.name = 'FetchError';
    }
  }
  return {
    mockFetchUrl: vi.fn(),
    mockFetchStealth: vi.fn(),
    mockExtractContent: vi.fn(),
    mockConvertToMarkdown: vi.fn(),
    mockIsAllowedByRobots: vi.fn().mockResolvedValue(true),
    mockGetCrawlDelay: vi.fn().mockResolvedValue(null),
    mockParseSitemap: vi.fn().mockResolvedValue([]),
    MockFetchError,
  };
});

vi.mock('../fetch.js', () => ({
  fetchUrl: mockFetchUrl,
  FetchError: MockFetchError,
}));
vi.mock('../fetch-stealth.js', () => ({ fetchStealth: mockFetchStealth }));
vi.mock('../fetch-render.js', () => ({ fetchRender: vi.fn() }));
vi.mock('../extract.js', () => ({
  extractContent: mockExtractContent,
  ExtractionError: class extends Error {},
}));
vi.mock('../convert.js', () => ({ convertToMarkdown: mockConvertToMarkdown }));
vi.mock('../robots.js', () => ({
  isAllowedByRobots: mockIsAllowedByRobots,
  getCrawlDelay: mockGetCrawlDelay,
  clearRobotsCache: vi.fn(),
  getSitemapUrls: vi.fn(),
}));
vi.mock('../sitemap.js', () => ({
  parseSitemap: mockParseSitemap,
  clearSitemapCache: vi.fn(),
}));
vi.mock('../telemetry.js', () => ({
  reportScraperEvent: vi.fn(),
}));

import { crawl, normalizeUrl, extractLinks } from '../crawl.js';

// ==============================
// Helpers
// ==============================

/** Set up mock pages keyed by normalized URL */
function setupPages(pages: Record<string, { html: string; title: string }>) {
  mockFetchUrl.mockImplementation(async (url: string) => {
    const normalized = normalizeUrl(url);
    const page = pages[normalized];
    if (!page) throw new MockFetchError('Not Found', 404, false);
    return { html: page.html, url, statusCode: 200, headers: {} } as FetchResult;
  });

  mockExtractContent.mockImplementation(async (fetchResult: FetchResult) => {
    const normalized = normalizeUrl(fetchResult.url);
    const page = pages[normalized];
    return { content: page?.html ?? '', title: page?.title ?? 'Unknown' } as ExtractResult;
  });

  mockConvertToMarkdown.mockImplementation(async () => ({
    markdown: '# Page\n\nContent',
    tokenCount: 5,
  }));
}

// ==============================
// normalizeUrl
// ==============================

describe('normalizeUrl', () => {
  it('strips fragment', () => {
    expect(normalizeUrl('https://example.com/page#section')).toBe('https://example.com/page');
  });

  it('strips trailing slash (non-root)', () => {
    expect(normalizeUrl('https://example.com/page/')).toBe('https://example.com/page');
  });

  it('preserves root trailing slash', () => {
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com/');
  });

  it('preserves query params', () => {
    expect(normalizeUrl('https://example.com/page?id=1')).toBe('https://example.com/page?id=1');
  });

  it('returns input for invalid URL', () => {
    expect(normalizeUrl('not-a-url')).toBe('not-a-url');
  });
});

// ==============================
// extractLinks
// ==============================

describe('extractLinks', () => {
  const base = 'https://example.com/page';

  it('extracts same-origin links', () => {
    const html = '<a href="/about">About</a><a href="/contact">Contact</a>';
    const links = extractLinks(html, base);
    expect(links).toContain('https://example.com/about');
    expect(links).toContain('https://example.com/contact');
  });

  it('resolves relative URLs', () => {
    const html = '<a href="./sub">Sub</a><a href="../other">Other</a>';
    const links = extractLinks(html, base);
    expect(links.length).toBeGreaterThan(0);
    links.forEach(link => expect(link).toMatch(/^https:\/\/example\.com/));
  });

  it('ignores external links', () => {
    const html = '<a href="https://other.com/page">External</a>';
    const links = extractLinks(html, base);
    expect(links).toHaveLength(0);
  });

  it('ignores mailto, tel, javascript schemes', () => {
    const html = '<a href="mailto:a@b.com">M</a><a href="tel:123">T</a><a href="javascript:void(0)">J</a>';
    const links = extractLinks(html, base);
    expect(links).toHaveLength(0);
  });

  it('ignores fragment-only links', () => {
    const html = '<a href="#section">Section</a>';
    const links = extractLinks(html, base);
    expect(links).toHaveLength(0);
  });

  it('ignores file extensions (.pdf, .jpg, etc.)', () => {
    const html = '<a href="/file.pdf">PDF</a><a href="/image.jpg">IMG</a>';
    const links = extractLinks(html, base);
    expect(links).toHaveLength(0);
  });

  it('deduplicates links', () => {
    const html = '<a href="/about">A</a><a href="/about">B</a><a href="/about#s">C</a>';
    const links = extractLinks(html, base);
    expect(links).toHaveLength(1);
  });

  it('returns empty for no links', () => {
    expect(extractLinks('<p>No links</p>', base)).toHaveLength(0);
  });

  it('returns empty for empty HTML', () => {
    expect(extractLinks('', base)).toHaveLength(0);
  });
});

// ==============================
// crawl
// ==============================

describe('crawl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsAllowedByRobots.mockResolvedValue(true);
    mockGetCrawlDelay.mockResolvedValue(null);
    mockParseSitemap.mockResolvedValue([]);
  });

  // ==========================================
  // Basic crawling
  // ==========================================

  it('crawls single page (depth=0)', async () => {
    setupPages({
      'https://example.com/': {
        html: '<h1>Home</h1><a href="/about">About</a>',
        title: 'Home',
      },
    });

    const result = await crawl({ url: 'https://example.com/', depth: 0, limit: 10 });

    expect(result.pages).toHaveLength(1);
    expect(result.totalCrawled).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it('discovers links via BFS (depth=1)', async () => {
    setupPages({
      'https://example.com/': {
        html: '<h1>Home</h1><a href="/about">About</a><a href="/blog">Blog</a>',
        title: 'Home',
      },
      'https://example.com/about': {
        html: '<h1>About</h1>',
        title: 'About',
      },
      'https://example.com/blog': {
        html: '<h1>Blog</h1>',
        title: 'Blog',
      },
    });

    const result = await crawl({ url: 'https://example.com/', depth: 1, limit: 10 });

    expect(result.totalCrawled).toBe(3);
    expect(result.pages).toHaveLength(3);
  });

  it('respects max depth', async () => {
    setupPages({
      'https://example.com/': {
        html: '<a href="/a">A</a>',
        title: 'Home',
      },
      'https://example.com/a': {
        html: '<a href="/b">B</a>',
        title: 'A',
      },
      'https://example.com/b': {
        html: '<h1>B</h1>',
        title: 'B',
      },
    });

    const result = await crawl({ url: 'https://example.com/', depth: 1, limit: 10 });

    // depth=0: home, depth=1: /a discovered from home — /b discovered from /a but depth=2 exceeds
    expect(result.totalCrawled).toBe(2);
  });

  it('respects page limit', async () => {
    setupPages({
      'https://example.com/': {
        html: '<a href="/a">A</a><a href="/b">B</a><a href="/c">C</a>',
        title: 'Home',
      },
      'https://example.com/a': { html: '<h1>A</h1>', title: 'A' },
      'https://example.com/b': { html: '<h1>B</h1>', title: 'B' },
      'https://example.com/c': { html: '<h1>C</h1>', title: 'C' },
    });

    const result = await crawl({ url: 'https://example.com/', depth: 2, limit: 2 });

    expect(result.totalCrawled).toBeLessThanOrEqual(2);
  });

  // ==========================================
  // Deduplication
  // ==========================================

  it('does not crawl same URL twice (circular links)', async () => {
    setupPages({
      'https://example.com/': {
        html: '<a href="/about">About</a>',
        title: 'Home',
      },
      'https://example.com/about': {
        html: '<a href="/">Home</a>',
        title: 'About',
      },
    });

    const result = await crawl({ url: 'https://example.com/', depth: 3, limit: 10 });

    expect(result.totalCrawled).toBe(2);
  });

  // ==========================================
  // Sitemap seeding
  // ==========================================

  it('seeds BFS queue from sitemap', async () => {
    mockParseSitemap.mockResolvedValue([
      { loc: 'https://example.com/docs/a' },
      { loc: 'https://example.com/docs/b' },
    ]);

    setupPages({
      'https://example.com/': { html: '<h1>Home</h1>', title: 'Home' },
      'https://example.com/docs/a': { html: '<h1>A</h1>', title: 'Doc A' },
      'https://example.com/docs/b': { html: '<h1>B</h1>', title: 'Doc B' },
    });

    const result = await crawl({ url: 'https://example.com/', depth: 1, limit: 10 });

    expect(result.totalCrawled).toBe(3);
  });

  it('emits console.debug when sitemap parsing fails', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    mockParseSitemap.mockRejectedValue(new Error('XML parse error'));

    setupPages({
      'https://example.com/': { html: '<h1>Home</h1>', title: 'Home' },
    });

    await crawl({ url: 'https://example.com/', depth: 1, limit: 10 });

    expect(debugSpy).toHaveBeenCalledOnce();
    expect(debugSpy.mock.calls[0][0].toLowerCase()).toContain('sitemap');

    debugSpy.mockRestore();
  });

  it('deduplicates sitemap entries before queueing', async () => {
    mockParseSitemap.mockResolvedValue([
      { loc: 'https://example.com/docs/a' },
      { loc: 'https://example.com/docs/a' },  // duplicate
      { loc: 'https://example.com/docs/a/' }, // normalizes to same
      { loc: 'https://example.com/docs/b' },
    ]);

    setupPages({
      'https://example.com/': { html: '<h1>Home</h1>', title: 'Home' },
      'https://example.com/docs/a': { html: '<h1>A</h1>', title: 'Doc A' },
      'https://example.com/docs/b': { html: '<h1>B</h1>', title: 'Doc B' },
    });

    const result = await crawl({ url: 'https://example.com/', depth: 1, limit: 10 });

    // Should only crawl 3 pages (home + a + b), not 5
    expect(result.totalCrawled).toBe(3);
    // totalDiscovered should reflect deduped count: 1 (start) + 2 (deduped sitemap) = 3
    expect(result.totalDiscovered).toBe(3);
  });

  // ==========================================
  // Robots.txt
  // ==========================================

  it('skips URLs disallowed by robots.txt', async () => {
    mockIsAllowedByRobots.mockImplementation(async (url: string) => {
      return !url.includes('/private');
    });

    setupPages({
      'https://example.com/': {
        html: '<a href="/public">P</a><a href="/private">X</a>',
        title: 'Home',
      },
      'https://example.com/public': { html: '<h1>Public</h1>', title: 'Public' },
      'https://example.com/private': { html: '<h1>Private</h1>', title: 'Private' },
    });

    const result = await crawl({ url: 'https://example.com/', depth: 1, limit: 10 });

    expect(result.totalCrawled).toBe(2); // home + public
    expect(result.totalSkipped).toBeGreaterThanOrEqual(1);
  });

  it('returns empty result when start URL blocked by robots', async () => {
    mockIsAllowedByRobots.mockResolvedValue(false);

    const result = await crawl({ url: 'https://example.com/', depth: 2, limit: 10 });

    expect(result.totalCrawled).toBe(0);
    expect(result.pages).toHaveLength(0);
  });

  // ==========================================
  // Filters
  // ==========================================

  it('applies include filter', async () => {
    setupPages({
      'https://example.com/': {
        html: '<a href="/docs/a">D</a><a href="/blog/x">B</a>',
        title: 'Home',
      },
      'https://example.com/docs/a': { html: '<h1>Doc</h1>', title: 'Doc' },
      'https://example.com/blog/x': { html: '<h1>Blog</h1>', title: 'Blog' },
    });

    const result = await crawl({
      url: 'https://example.com/',
      depth: 1,
      limit: 10,
      include: ['**/docs/**'],
    });

    // Home doesn't match /docs/**, but start URL is always included
    // /docs/a matches, /blog/x doesn't
    const urls = result.pages.map(p => p.url);
    expect(urls.some(u => u.includes('/docs/'))).toBe(true);
    expect(urls.every(u => !u.includes('/blog/'))).toBe(true);
  });

  it('applies exclude filter', async () => {
    setupPages({
      'https://example.com/': {
        html: '<a href="/docs">D</a><a href="/admin">A</a>',
        title: 'Home',
      },
      'https://example.com/docs': { html: '<h1>Docs</h1>', title: 'Docs' },
      'https://example.com/admin': { html: '<h1>Admin</h1>', title: 'Admin' },
    });

    const result = await crawl({
      url: 'https://example.com/',
      depth: 1,
      limit: 10,
      exclude: ['**/admin**'],
    });

    const urls = result.pages.map(p => p.url);
    expect(urls.every(u => !u.includes('/admin'))).toBe(true);
  });

  // ==========================================
  // Error handling
  // ==========================================

  it('handles page errors gracefully (continues crawling)', async () => {
    mockFetchUrl.mockImplementation(async (url: string) => {
      if (url.includes('/broken')) throw new MockFetchError('HTTP 500', 500, true);
      return { html: '<a href="/broken">B</a><a href="/ok">O</a>', url, statusCode: 200, headers: {} };
    });
    mockExtractContent.mockResolvedValue({ content: '<p>ok</p>', title: 'OK' });
    mockConvertToMarkdown.mockResolvedValue({ markdown: '# OK', tokenCount: 2 });

    setupPages({
      'https://example.com/': {
        html: '<a href="/broken">B</a><a href="/ok">O</a>',
        title: 'Home',
      },
      'https://example.com/ok': { html: '<h1>OK</h1>', title: 'OK' },
    });

    // Re-setup fetch to handle /broken
    mockFetchUrl.mockImplementation(async (url: string) => {
      if (url.includes('/broken')) throw new MockFetchError('HTTP 500', 500, true);
      const pages: Record<string, { html: string }> = {
        'https://example.com/': { html: '<a href="/broken">B</a><a href="/ok">O</a>' },
        'https://example.com/ok': { html: '<h1>OK</h1>' },
      };
      const page = pages[normalizeUrl(url)];
      if (!page) throw new MockFetchError('Not Found', 404, false);
      return { html: page.html, url, statusCode: 200, headers: {} };
    });

    const result = await crawl({ url: 'https://example.com/', depth: 1, limit: 10 });

    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors[0].url).toContain('/broken');
    expect(result.totalCrawled).toBeGreaterThanOrEqual(1);
  });

  // ==========================================
  // Validation
  // ==========================================

  it('throws on invalid URL', async () => {
    await expect(crawl({ url: 'not-a-url' })).rejects.toThrow();
  });

  it('throws on depth < 0', async () => {
    await expect(crawl({ url: 'https://example.com/', depth: -1 })).rejects.toThrow();
  });

  it('throws on limit < 1', async () => {
    await expect(crawl({ url: 'https://example.com/', limit: 0 })).rejects.toThrow();
  });

  it('throws on concurrency < 1', async () => {
    await expect(crawl({ url: 'https://example.com/', concurrency: 0 })).rejects.toThrow();
  });

  it('throws FetchError on negative timeout', async () => {
    await expect(crawl({ url: 'https://example.com/', timeout: -1 })).rejects.toThrow(/timeout must be a positive number/);
  });

  it('throws FetchError on zero timeout', async () => {
    await expect(crawl({ url: 'https://example.com/', timeout: 0 })).rejects.toThrow(/timeout must be a positive number/);
  });

  it('throws FetchError on NaN timeout', async () => {
    await expect(crawl({ url: 'https://example.com/', timeout: NaN })).rejects.toThrow(/timeout must be a positive number/);
  });

  it('throws FetchError (not generic Error) for depth validation', async () => {
    await expect(crawl({ url: 'https://example.com/', depth: -1 })).rejects.toThrow(MockFetchError);
  });

  it('throws FetchError (not generic Error) for limit validation', async () => {
    await expect(crawl({ url: 'https://example.com/', limit: 0 })).rejects.toThrow(MockFetchError);
  });

  it('throws FetchError (not generic Error) for concurrency validation', async () => {
    await expect(crawl({ url: 'https://example.com/', concurrency: 0 })).rejects.toThrow(MockFetchError);
  });

  // ==========================================
  // CrawlResult shape
  // ==========================================

  it('returns correct CrawlResult shape', async () => {
    setupPages({
      'https://example.com/': { html: '<h1>Home</h1>', title: 'Home' },
    });

    const result = await crawl({ url: 'https://example.com/', depth: 0 });

    expect(result).toHaveProperty('pages');
    expect(result).toHaveProperty('totalDiscovered');
    expect(result).toHaveProperty('totalCrawled');
    expect(result).toHaveProperty('totalSkipped');
    expect(result).toHaveProperty('errors');
    expect(result).toHaveProperty('duration');
    expect(typeof result.duration).toBe('number');
    expect(result.pages[0]).toHaveProperty('depth');
  });
});
