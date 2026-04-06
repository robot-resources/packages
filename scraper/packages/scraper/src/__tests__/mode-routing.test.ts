/**
 * Mode routing + auto-fallback tests
 * TKT-SCRAPER-074: Wire mode routing into scrape() with auto-fallback logic
 *
 * Tests mode dispatch (fast/stealth/render/auto) and auto-fallback from
 * tier 1 to tier 2 on 403 or challenge page detection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FetchResult, ExtractResult, ConvertResult } from '../types.js';

// ==============================
// Mocks (vi.hoisted runs before vi.mock hoisting)
// ==============================

const {
  mockFetchUrl,
  mockFetchStealth,
  mockFetchRender,
  mockExtractContent,
  mockConvertToMarkdown,
  mockIsAllowedByRobots,
  mockReportScraperEvent,
  MockFetchError,
} = vi.hoisted(() => {
  class MockFetchError extends Error {
    public readonly statusCode?: number;
    public readonly retryable: boolean;
    constructor(message: string, statusCode?: number, retryable: boolean = false) {
      super(message);
      this.name = 'FetchError';
      this.statusCode = statusCode;
      this.retryable = retryable;
    }
  }

  return {
    mockFetchUrl: vi.fn(),
    mockFetchStealth: vi.fn(),
    mockFetchRender: vi.fn(),
    mockExtractContent: vi.fn(),
    mockConvertToMarkdown: vi.fn(),
    mockIsAllowedByRobots: vi.fn(),
    mockReportScraperEvent: vi.fn(),
    MockFetchError,
  };
});

vi.mock('../fetch.js', () => ({
  fetchUrl: mockFetchUrl,
  FetchError: MockFetchError,
}));

vi.mock('../fetch-stealth.js', () => ({
  fetchStealth: mockFetchStealth,
}));

vi.mock('../fetch-render.js', () => ({
  fetchRender: mockFetchRender,
}));

vi.mock('../extract.js', () => ({
  extractContent: mockExtractContent,
  ExtractionError: class ExtractionError extends Error {
    constructor(message: string, public readonly code: string) {
      super(message);
      this.name = 'ExtractionError';
    }
  },
}));

vi.mock('../convert.js', () => ({
  convertToMarkdown: mockConvertToMarkdown,
  estimateTokens: (text: string) => Math.ceil(text.length / 4),
}));

vi.mock('../robots.js', () => ({
  isAllowedByRobots: mockIsAllowedByRobots,
  clearRobotsCache: vi.fn(),
  getSitemapUrls: vi.fn(),
  getCrawlDelay: vi.fn(),
}));

vi.mock('../sitemap.js', () => ({
  parseSitemap: vi.fn(),
  clearSitemapCache: vi.fn(),
}));

vi.mock('../telemetry.js', () => ({
  reportScraperEvent: mockReportScraperEvent,
}));

import { scrape, isChallengeResponse } from '../index.js';

// ==============================
// Helpers
// ==============================

const GOOD_FETCH: FetchResult = {
  html: '<html><body><h1>Test</h1><p>Content</p></body></html>',
  url: 'https://example.com/page',
  statusCode: 200,
  headers: { 'content-type': 'text/html' },
};

const GOOD_EXTRACT: ExtractResult = {
  content: '<h1>Test</h1><p>Content</p>',
  title: 'Test',
};

const GOOD_CONVERT: ConvertResult = {
  markdown: '# Test\n\nContent',
  tokenCount: 5,
};

function setupSuccessMocks(fetchResult: FetchResult = GOOD_FETCH) {
  mockFetchUrl.mockResolvedValue(fetchResult);
  mockFetchStealth.mockResolvedValue(fetchResult);
  mockFetchRender.mockResolvedValue(fetchResult);
  mockExtractContent.mockResolvedValue(GOOD_EXTRACT);
  mockConvertToMarkdown.mockResolvedValue(GOOD_CONVERT);
}

// ==============================
// Tests
// ==============================

describe('mode routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ==========================================
  // Default behavior (backward compat)
  // ==========================================

  it('scrape(url) without mode defaults to auto — calls fetchUrl', async () => {
    setupSuccessMocks();

    await scrape('https://example.com/page');

    expect(mockFetchUrl).toHaveBeenCalledTimes(1);
    expect(mockFetchStealth).not.toHaveBeenCalled();
  });

  it('scrape(url) without mode returns same ScrapeResult shape', async () => {
    setupSuccessMocks();

    const result = await scrape('https://example.com/page');

    expect(result).toMatchObject({
      markdown: '# Test\n\nContent',
      tokenCount: 5,
      title: 'Test',
      url: 'https://example.com/page',
    });
  });

  // ==========================================
  // mode: 'fast'
  // ==========================================

  it("mode 'fast' calls fetchUrl only", async () => {
    setupSuccessMocks();

    await scrape('https://example.com/page', { mode: 'fast' });

    expect(mockFetchUrl).toHaveBeenCalledTimes(1);
    expect(mockFetchStealth).not.toHaveBeenCalled();
  });

  it("mode 'fast' throws on 403 without fallback", async () => {
    mockFetchUrl.mockRejectedValue(new MockFetchError('HTTP 403', 403, false));

    await expect(
      scrape('https://example.com/page', { mode: 'fast' })
    ).rejects.toThrow('HTTP 403');

    expect(mockFetchStealth).not.toHaveBeenCalled();
  });

  // ==========================================
  // mode: 'stealth'
  // ==========================================

  it("mode 'stealth' calls fetchStealth directly", async () => {
    setupSuccessMocks();

    await scrape('https://example.com/page', { mode: 'stealth' });

    expect(mockFetchStealth).toHaveBeenCalledTimes(1);
    expect(mockFetchUrl).not.toHaveBeenCalled();
  });

  // ==========================================
  // mode: 'render'
  // ==========================================

  it("mode 'render' calls fetchRender directly", async () => {
    mockFetchRender.mockResolvedValue(GOOD_FETCH);
    mockExtractContent.mockResolvedValue(GOOD_EXTRACT);
    mockConvertToMarkdown.mockResolvedValue(GOOD_CONVERT);

    await scrape('https://example.com/page', { mode: 'render' });

    expect(mockFetchRender).toHaveBeenCalledTimes(1);
    expect(mockFetchUrl).not.toHaveBeenCalled();
    expect(mockFetchStealth).not.toHaveBeenCalled();
  });

  // ==========================================
  // mode: 'auto' — fallback scenarios
  // ==========================================

  it("mode 'auto' falls back to stealth on 403", async () => {
    mockFetchUrl.mockRejectedValue(new MockFetchError('HTTP 403', 403, false));
    mockFetchStealth.mockResolvedValue(GOOD_FETCH);
    mockExtractContent.mockResolvedValue(GOOD_EXTRACT);
    mockConvertToMarkdown.mockResolvedValue(GOOD_CONVERT);

    const result = await scrape('https://example.com/page', { mode: 'auto' });

    expect(mockFetchUrl).toHaveBeenCalledTimes(1);
    expect(mockFetchStealth).toHaveBeenCalledTimes(1);
    expect(result.markdown).toBe('# Test\n\nContent');
  });

  it("mode 'auto' falls back to stealth on challenge page (200 + CF markers)", async () => {
    const challengeResult: FetchResult = {
      html: '<html><head><title>Just a moment</title></head><body>Checking browser</body></html>',
      url: 'https://example.com/page',
      statusCode: 200,
      headers: {},
    };
    mockFetchUrl.mockResolvedValue(challengeResult);
    mockFetchStealth.mockResolvedValue(GOOD_FETCH);
    mockExtractContent.mockResolvedValue(GOOD_EXTRACT);
    mockConvertToMarkdown.mockResolvedValue(GOOD_CONVERT);

    const result = await scrape('https://example.com/page', { mode: 'auto' });

    expect(mockFetchUrl).toHaveBeenCalledTimes(1);
    expect(mockFetchStealth).toHaveBeenCalledTimes(1);
    expect(result.markdown).toBe('# Test\n\nContent');
  });

  it("mode 'auto' throws stealth error when both tiers fail", async () => {
    mockFetchUrl.mockRejectedValue(new MockFetchError('HTTP 403', 403, false));
    mockFetchStealth.mockRejectedValue(new MockFetchError('HTTP 403 stealth', 403, false));

    await expect(
      scrape('https://example.com/page', { mode: 'auto' })
    ).rejects.toThrow('HTTP 403 stealth');
  });

  it("mode 'auto' does NOT fall back on extraction error", async () => {
    mockFetchUrl.mockResolvedValue(GOOD_FETCH);
    mockExtractContent.mockRejectedValue(new Error('Extraction failed'));

    await expect(
      scrape('https://example.com/page', { mode: 'auto' })
    ).rejects.toThrow('Extraction failed');

    expect(mockFetchStealth).not.toHaveBeenCalled();
  });

  it("mode 'auto' does NOT fall back on non-403 fetch error (e.g. 500)", async () => {
    mockFetchUrl.mockRejectedValue(new MockFetchError('HTTP 500', 500, true));

    await expect(
      scrape('https://example.com/page', { mode: 'auto' })
    ).rejects.toThrow('HTTP 500');

    expect(mockFetchStealth).not.toHaveBeenCalled();
  });

  // ==========================================
  // Invalid mode (runtime validation)
  // ==========================================

  it('throws FetchError on unrecognized mode string', async () => {
    await expect(
      scrape('https://example.com/page', { mode: 'turbo' as any })
    ).rejects.toThrow(/Invalid fetch mode/);

    expect(mockFetchUrl).not.toHaveBeenCalled();
    expect(mockFetchStealth).not.toHaveBeenCalled();
    expect(mockFetchRender).not.toHaveBeenCalled();
  });

  it('throws FetchError on empty mode string', async () => {
    await expect(
      scrape('https://example.com/page', { mode: '' as any })
    ).rejects.toThrow(/Invalid fetch mode/);
  });

  it('rejects case-variant mode (AUTO vs auto)', async () => {
    await expect(
      scrape('https://example.com/page', { mode: 'AUTO' as any })
    ).rejects.toThrow(/Invalid fetch mode/);
  });

  // ==========================================
  // Timeout validation
  // ==========================================

  it('throws FetchError on negative timeout', async () => {
    await expect(
      scrape('https://example.com/page', { timeout: -1 })
    ).rejects.toThrow(/timeout must be a positive number/);

    expect(mockFetchUrl).not.toHaveBeenCalled();
  });

  it('throws FetchError on zero timeout', async () => {
    await expect(
      scrape('https://example.com/page', { timeout: 0 })
    ).rejects.toThrow(/timeout must be a positive number/);
  });

  it('allows undefined timeout (default behavior)', async () => {
    setupSuccessMocks();

    const result = await scrape('https://example.com/page');

    expect(result.markdown).toBe('# Test\n\nContent');
  });

  // ==========================================
  // robots.txt + mode
  // ==========================================

  it('robots.txt check runs before mode routing', async () => {
    mockIsAllowedByRobots.mockResolvedValue(false);

    await expect(
      scrape('https://example.com/page', { mode: 'stealth', respectRobots: true })
    ).rejects.toThrow(/robots\.txt/);

    expect(mockFetchUrl).not.toHaveBeenCalled();
    expect(mockFetchStealth).not.toHaveBeenCalled();
  });

  // ==========================================
  // Telemetry
  // ==========================================

  it('telemetry fires on success with mode routing', async () => {
    setupSuccessMocks();

    await scrape('https://example.com/page', { mode: 'stealth' });

    expect(mockReportScraperEvent).toHaveBeenCalledWith(
      expect.objectContaining({ success: true })
    );
  });

  it('telemetry fires on error with mode routing', async () => {
    mockFetchStealth.mockRejectedValue(new MockFetchError('HTTP 500', 500));

    await scrape('https://example.com/page', { mode: 'stealth' }).catch(() => {});

    expect(mockReportScraperEvent).toHaveBeenCalledWith(
      expect.objectContaining({ success: false })
    );
  });
});

describe('isChallengeResponse', () => {
  it("detects Cloudflare 'cf-browser-verification' marker", () => {
    const result: FetchResult = {
      html: '<div id="cf-browser-verification">Please wait...</div>',
      url: 'https://example.com',
      statusCode: 200,
      headers: {},
    };
    expect(isChallengeResponse(result)).toBe(true);
  });

  it("detects Cloudflare 'Just a moment' title", () => {
    const result: FetchResult = {
      html: '<html><head><title>Just a moment...</title></head></html>',
      url: 'https://example.com',
      statusCode: 200,
      headers: {},
    };
    expect(isChallengeResponse(result)).toBe(true);
  });

  it("detects Cloudflare '_cf_chl_opt' JS variable", () => {
    const result: FetchResult = {
      html: '<script>var _cf_chl_opt = { "cvId": "2" };</script>',
      url: 'https://example.com',
      statusCode: 200,
      headers: {},
    };
    expect(isChallengeResponse(result)).toBe(true);
  });

  it('returns false for normal HTML', () => {
    const result: FetchResult = {
      html: '<html><body><h1>Normal Page</h1><p>Content</p></body></html>',
      url: 'https://example.com',
      statusCode: 200,
      headers: {},
    };
    expect(isChallengeResponse(result)).toBe(false);
  });

  it('returns false for empty HTML', () => {
    const result: FetchResult = {
      html: '',
      url: 'https://example.com',
      statusCode: 200,
      headers: {},
    };
    expect(isChallengeResponse(result)).toBe(false);
  });
});

// ==============================
// TKT-SCRAPER-108: SSL/TLS and network error fallback (PR #84)
// ==============================

describe('auto mode SSL/TLS and network error fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('falls back to stealth on TLS cert error (UNABLE_TO_GET_ISSUER_CERT_LOCALLY)', async () => {
    mockFetchUrl.mockRejectedValue(new Error('UNABLE_TO_GET_ISSUER_CERT_LOCALLY'));
    mockFetchStealth.mockResolvedValue(GOOD_FETCH);
    mockExtractContent.mockResolvedValue(GOOD_EXTRACT);
    mockConvertToMarkdown.mockResolvedValue(GOOD_CONVERT);

    const result = await scrape('https://example.com/page', { mode: 'auto' });

    expect(mockFetchUrl).toHaveBeenCalledTimes(1);
    expect(mockFetchStealth).toHaveBeenCalledTimes(1);
    expect(result.markdown).toBe('# Test\n\nContent');
  });

  it('falls back to stealth on ECONNREFUSED', async () => {
    mockFetchUrl.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:443'));
    mockFetchStealth.mockResolvedValue(GOOD_FETCH);
    mockExtractContent.mockResolvedValue(GOOD_EXTRACT);
    mockConvertToMarkdown.mockResolvedValue(GOOD_CONVERT);

    const result = await scrape('https://example.com/page', { mode: 'auto' });

    expect(mockFetchStealth).toHaveBeenCalledTimes(1);
    expect(result.markdown).toBe('# Test\n\nContent');
  });

  it('falls back to stealth on ENOTFOUND', async () => {
    mockFetchUrl.mockRejectedValue(new Error('getaddrinfo ENOTFOUND example.com'));
    mockFetchStealth.mockResolvedValue(GOOD_FETCH);
    mockExtractContent.mockResolvedValue(GOOD_EXTRACT);
    mockConvertToMarkdown.mockResolvedValue(GOOD_CONVERT);

    const result = await scrape('https://example.com/page', { mode: 'auto' });

    expect(mockFetchStealth).toHaveBeenCalledTimes(1);
    expect(result.markdown).toBe('# Test\n\nContent');
  });

  it('falls back to stealth on TypeError from fetch internals', async () => {
    mockFetchUrl.mockRejectedValue(new TypeError('fetch failed'));
    mockFetchStealth.mockResolvedValue(GOOD_FETCH);
    mockExtractContent.mockResolvedValue(GOOD_EXTRACT);
    mockConvertToMarkdown.mockResolvedValue(GOOD_CONVERT);

    const result = await scrape('https://example.com/page', { mode: 'auto' });

    expect(mockFetchStealth).toHaveBeenCalledTimes(1);
    expect(result.markdown).toBe('# Test\n\nContent');
  });

  it('throws stealth error when stealth also fails after TLS fallback', async () => {
    mockFetchUrl.mockRejectedValue(new Error('UNABLE_TO_GET_ISSUER_CERT_LOCALLY'));
    mockFetchStealth.mockRejectedValue(new MockFetchError('Stealth also failed', 403));

    await expect(
      scrape('https://example.com/page', { mode: 'auto' })
    ).rejects.toThrow('Stealth also failed');

    expect(mockFetchUrl).toHaveBeenCalledTimes(1);
    expect(mockFetchStealth).toHaveBeenCalledTimes(1);
  });

  it('does NOT fall back on FetchError 404 (real HTTP error)', async () => {
    mockFetchUrl.mockRejectedValue(new MockFetchError('Not Found', 404));

    await expect(
      scrape('https://example.com/page', { mode: 'auto' })
    ).rejects.toThrow('Not Found');

    expect(mockFetchStealth).not.toHaveBeenCalled();
  });

  it('does NOT fall back on FetchError 500 (server error)', async () => {
    mockFetchUrl.mockRejectedValue(new MockFetchError('Internal Server Error', 500));

    await expect(
      scrape('https://example.com/page', { mode: 'auto' })
    ).rejects.toThrow('Internal Server Error');

    expect(mockFetchStealth).not.toHaveBeenCalled();
  });
});
