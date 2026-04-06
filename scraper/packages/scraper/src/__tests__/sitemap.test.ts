/**
 * Sitemap parser tests
 * TKT-SCRAPER-077: Implement sitemap.xml parser
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { parseSitemap, clearSitemapCache } from '../sitemap.js';

function sitemapResponse(body: string, status = 200) {
  return Promise.resolve(new Response(body, { status }));
}

const VALID_SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/page1</loc>
    <lastmod>2026-01-01</lastmod>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://example.com/page2</loc>
    <lastmod>2026-02-01</lastmod>
  </url>
  <url>
    <loc>https://example.com/page3</loc>
  </url>
</urlset>`;

const SITEMAP_INDEX = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>https://example.com/sitemap-pages.xml</loc>
  </sitemap>
  <sitemap>
    <loc>https://example.com/sitemap-blog.xml</loc>
  </sitemap>
</sitemapindex>`;

const SUB_SITEMAP_1 = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/about</loc></url>
</urlset>`;

const SUB_SITEMAP_2 = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/blog/post1</loc></url>
</urlset>`;

describe('parseSitemap', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearSitemapCache();
    mockFetch.mockReset();
  });

  // ==========================================
  // Positive cases
  // ==========================================

  it('extracts URLs from valid sitemap XML', async () => {
    mockFetch.mockReturnValueOnce(sitemapResponse(VALID_SITEMAP));

    const entries = await parseSitemap('https://example.com/sitemap.xml');

    expect(entries).toHaveLength(3);
    expect(entries[0].loc).toBe('https://example.com/page1');
    expect(entries[1].loc).toBe('https://example.com/page2');
    expect(entries[2].loc).toBe('https://example.com/page3');
  });

  it('extracts lastmod and priority when present', async () => {
    mockFetch.mockReturnValueOnce(sitemapResponse(VALID_SITEMAP));

    const entries = await parseSitemap('https://example.com/sitemap.xml');

    expect(entries[0].lastmod).toBe('2026-01-01');
    expect(entries[0].priority).toBe(0.8);
    expect(entries[1].lastmod).toBe('2026-02-01');
    expect(entries[1].priority).toBeUndefined();
    expect(entries[2].lastmod).toBeUndefined();
    expect(entries[2].priority).toBeUndefined();
  });

  it('handles sitemap index by recursively fetching sub-sitemaps', async () => {
    mockFetch
      .mockReturnValueOnce(sitemapResponse(SITEMAP_INDEX))
      .mockReturnValueOnce(sitemapResponse(SUB_SITEMAP_1))
      .mockReturnValueOnce(sitemapResponse(SUB_SITEMAP_2));

    const entries = await parseSitemap('https://example.com/sitemap.xml');

    expect(entries).toHaveLength(2);
    expect(entries[0].loc).toBe('https://example.com/about');
    expect(entries[1].loc).toBe('https://example.com/blog/post1');
  });

  it('handles XML namespace prefixes in tags', async () => {
    const namespacedSitemap = `<?xml version="1.0"?>
<ns:urlset xmlns:ns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <ns:url>
    <ns:loc>https://example.com/namespaced</ns:loc>
  </ns:url>
</ns:urlset>`;

    mockFetch.mockReturnValueOnce(sitemapResponse(namespacedSitemap));

    const entries = await parseSitemap('https://example.com/sitemap.xml');

    expect(entries).toHaveLength(1);
    expect(entries[0].loc).toBe('https://example.com/namespaced');
  });

  it('returns empty array for empty sitemap (valid XML, no URLs)', async () => {
    const emptySitemap = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
</urlset>`;

    mockFetch.mockReturnValueOnce(sitemapResponse(emptySitemap));

    const entries = await parseSitemap('https://example.com/sitemap.xml');

    expect(entries).toEqual([]);
  });

  // ==========================================
  // Fail-open (negative tests)
  // ==========================================

  it('returns empty array when sitemap returns 404 (fail-open)', async () => {
    mockFetch.mockReturnValueOnce(sitemapResponse('Not Found', 404));

    const entries = await parseSitemap('https://example.com/sitemap.xml');

    expect(entries).toEqual([]);
  });

  it('returns empty array when fetch fails with network error (fail-open)', async () => {
    mockFetch.mockReturnValueOnce(Promise.reject(new Error('Network error')));

    const entries = await parseSitemap('https://example.com/sitemap.xml');

    expect(entries).toEqual([]);
  });

  it('returns empty array for invalid XML (fail-open, no crash)', async () => {
    mockFetch.mockReturnValueOnce(sitemapResponse('<not valid xml at all'));

    const entries = await parseSitemap('https://example.com/sitemap.xml');

    expect(entries).toEqual([]);
  });

  // ==========================================
  // Same-origin filter
  // ==========================================

  it('filters out URLs from different origins', async () => {
    const mixedSitemap = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/page1</loc></url>
  <url><loc>https://other-site.com/page2</loc></url>
  <url><loc>https://subdomain.example.com/page3</loc></url>
  <url><loc>https://example.com/page4</loc></url>
</urlset>`;

    mockFetch.mockReturnValueOnce(sitemapResponse(mixedSitemap));

    const entries = await parseSitemap('https://example.com/sitemap.xml');

    expect(entries).toHaveLength(2);
    expect(entries[0].loc).toBe('https://example.com/page1');
    expect(entries[1].loc).toBe('https://example.com/page4');
  });

  // ==========================================
  // Recursion limit
  // ==========================================

  it('stops recursion at depth 2 (index → sitemap → done)', async () => {
    // Level 0: sitemap index → points to another index
    const nestedIndex = `<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/sitemap-nested.xml</loc></sitemap>
</sitemapindex>`;

    // Level 1: another index (should NOT be recursed further)
    const deeperIndex = `<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/sitemap-too-deep.xml</loc></sitemap>
</sitemapindex>`;

    mockFetch
      .mockReturnValueOnce(sitemapResponse(nestedIndex))
      .mockReturnValueOnce(sitemapResponse(deeperIndex));

    const entries = await parseSitemap('https://example.com/sitemap.xml');

    // Should have fetched 2 times (depth 0 and depth 1) but NOT depth 2
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(entries).toEqual([]);
  });

  // ==========================================
  // Caching
  // ==========================================

  it('caches parsed sitemaps — second call does not re-fetch', async () => {
    mockFetch.mockReturnValue(sitemapResponse(VALID_SITEMAP));

    await parseSitemap('https://example.com/sitemap.xml');
    const entries = await parseSitemap('https://example.com/sitemap.xml');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(entries).toHaveLength(3);
  });

  it('clearSitemapCache resets the cache', async () => {
    mockFetch.mockReturnValue(sitemapResponse(VALID_SITEMAP));

    await parseSitemap('https://example.com/sitemap.xml');
    clearSitemapCache();
    await parseSitemap('https://example.com/sitemap.xml');

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('caches separately for different domains', async () => {
    mockFetch.mockReturnValue(sitemapResponse(VALID_SITEMAP));

    await parseSitemap('https://example.com/sitemap.xml');
    await parseSitemap('https://other.com/sitemap.xml');

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  // ==========================================
  // Timeout
  // ==========================================

  it('respects timeout parameter', async () => {
    mockFetch.mockReturnValueOnce(
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('AbortError')), 100)
      )
    );

    const entries = await parseSitemap('https://example.com/sitemap.xml', 50);

    // Fail-open: returns empty array on timeout
    expect(entries).toEqual([]);
  });
});
