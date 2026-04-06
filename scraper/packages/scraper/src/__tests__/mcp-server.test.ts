/**
 * MCP server unit tests
 * TKT-SCRAPER-109: compressUrl, crawlUrl, formatError (PR #86)
 *
 * Tests the MCP tool entry points consolidated into packages/scraper/src/mcp-server.ts.
 * All pipeline dependencies are mocked — these are unit tests for the MCP layer only.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ==============================
// Mocks (vi.hoisted runs before vi.mock hoisting)
// ==============================

const {
  mockFetchWithMode,
  mockExtractContent,
  mockConvertToMarkdown,
  mockEstimateTokens,
  mockCrawl,
  mockReportScraperEvent,
  MockFetchError,
  MockExtractionError,
} = vi.hoisted(() => {
  class MockFetchError extends Error {
    public readonly statusCode?: number;
    public readonly retryable: boolean;
    constructor(message: string, statusCode?: number, retryable = false) {
      super(message);
      this.name = 'FetchError';
      this.statusCode = statusCode;
      this.retryable = retryable;
    }
  }

  class MockExtractionError extends Error {
    public readonly code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = 'ExtractionError';
      this.code = code;
    }
  }

  return {
    mockFetchWithMode: vi.fn(),
    mockExtractContent: vi.fn(),
    mockConvertToMarkdown: vi.fn(),
    mockEstimateTokens: vi.fn(),
    mockCrawl: vi.fn(),
    mockReportScraperEvent: vi.fn(),
    MockFetchError,
    MockExtractionError,
  };
});

vi.mock('../fetch-mode.js', () => ({
  fetchWithMode: mockFetchWithMode,
}));

vi.mock('../extract.js', () => ({
  extractContent: mockExtractContent,
  ExtractionError: MockExtractionError,
}));

vi.mock('../convert.js', () => ({
  convertToMarkdown: mockConvertToMarkdown,
  estimateTokens: mockEstimateTokens,
}));

vi.mock('../crawl.js', () => ({
  crawl: mockCrawl,
}));

vi.mock('../fetch.js', () => ({
  FetchError: MockFetchError,
}));

vi.mock('../telemetry.js', () => ({
  reportScraperEvent: mockReportScraperEvent,
}));

import { compressUrl, crawlUrl, formatError } from '../mcp-server.js';

// ==============================
// Test fixtures
// ==============================

const mockFetchResult = {
  html: '<html><body><h1>Test</h1><p>Content here</p></body></html>',
  url: 'https://example.com',
  statusCode: 200,
  headers: { 'content-type': 'text/html' },
};

const mockExtractResult = {
  content: '<h1>Test</h1><p>Content here</p>',
  title: 'Test Page',
  author: 'Author',
  siteName: 'Example',
};

const mockConvertResult = {
  markdown: '# Test\n\nContent here',
  tokenCount: 10,
};

// ==============================
// Tests
// ==============================

describe('formatError', () => {
  const url = 'https://example.com/page';

  describe('FetchError branches', () => {
    it('returns 403 message for access denied', () => {
      const error = new MockFetchError('Forbidden', 403);
      const result = formatError(url, error);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Access denied (HTTP 403)');
      expect(result.content[0].text).toContain(url);
    });

    it('returns 404 message for page not found', () => {
      const error = new MockFetchError('Not Found', 404);
      const result = formatError(url, error);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Page not found (HTTP 404)');
      expect(result.content[0].text).toContain(url);
    });

    it('returns server error message for 5xx', () => {
      const error = new MockFetchError('Internal Server Error', 500);
      const result = formatError(url, error);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Server error (HTTP 500)');
    });

    it('returns server error for 502', () => {
      const error = new MockFetchError('Bad Gateway', 502);
      const result = formatError(url, error);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Server error (HTTP 502)');
    });

    it('returns timeout message when message contains timeout', () => {
      const error = new MockFetchError('Request timeout after 10000ms');
      const result = formatError(url, error);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('timed out');
      expect(result.content[0].text).toContain('timeout parameter');
    });

    it('returns timeout message when message contains Timeout (capitalized)', () => {
      const error = new MockFetchError('Timeout exceeded');
      const result = formatError(url, error);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('timed out');
    });

    it('returns invalid URL message', () => {
      const error = new MockFetchError('Invalid URL: not-a-url');
      const result = formatError(url, error);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid URL');
      expect(result.content[0].text).toContain('http://');
    });

    it('returns generic FetchError with retryable hint', () => {
      const error = new MockFetchError('Connection reset', undefined, true);
      const result = formatError(url, error);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to fetch');
      expect(result.content[0].text).toContain('Connection reset');
      expect(result.content[0].text).toContain('Retries exhausted');
    });

    it('returns generic FetchError without retryable hint', () => {
      const error = new MockFetchError('DNS lookup failed', undefined, false);
      const result = formatError(url, error);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to fetch');
      expect(result.content[0].text).toContain('DNS lookup failed');
      expect(result.content[0].text).not.toContain('Retries exhausted');
    });
  });

  describe('ExtractionError branches', () => {
    it('returns EMPTY_HTML message suggesting render mode', () => {
      const error = new MockExtractionError('Empty HTML content', 'EMPTY_HTML');
      const result = formatError(url, error);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('empty HTML');
      expect(result.content[0].text).toContain("mode: 'render'");
    });

    it('returns NO_CONTENT message', () => {
      const error = new MockExtractionError('No content found', 'NO_CONTENT');
      const result = formatError(url, error);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Could not extract meaningful content');
    });

    it('returns generic ExtractionError message', () => {
      const error = new MockExtractionError('Parse failed', 'UNKNOWN_CODE');
      const result = formatError(url, error);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Content extraction failed');
      expect(result.content[0].text).toContain('Parse failed');
    });
  });

  describe('catch-all branch', () => {
    it('returns unexpected error for generic Error', () => {
      const error = new Error('Something broke');
      const result = formatError(url, error);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unexpected error');
      expect(result.content[0].text).toContain('Something broke');
    });

    it('handles non-Error thrown values (string)', () => {
      const result = formatError(url, 'raw string error');

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unexpected error');
      expect(result.content[0].text).toContain('raw string error');
    });

    it('handles non-Error thrown values (number)', () => {
      const result = formatError(url, 42);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('42');
    });

    it('handles null/undefined thrown values', () => {
      const result = formatError(url, undefined);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('undefined');
    });
  });

  describe('output structure', () => {
    it('always returns content array with type text', () => {
      const result = formatError(url, new Error('test'));

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(typeof result.content[0].text).toBe('string');
    });

    it('always returns isError: true', () => {
      const result = formatError(url, new Error('test'));
      expect(result.isError).toBe(true);
    });
  });
});

describe('compressUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchWithMode.mockResolvedValue(mockFetchResult);
    mockExtractContent.mockResolvedValue(mockExtractResult);
    mockConvertToMarkdown.mockResolvedValue(mockConvertResult);
    mockEstimateTokens.mockReturnValue(100);
  });

  describe('success path', () => {
    it('returns markdown content with structured metadata', async () => {
      const result = await compressUrl({ url: 'https://example.com' });

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toBe(mockConvertResult.markdown);
      expect(result.structuredContent).toBeDefined();
      expect(result.structuredContent.markdown).toBe(mockConvertResult.markdown);
      expect(result.structuredContent.tokenCount).toBe(10);
      expect(result.structuredContent.title).toBe('Test Page');
      expect(result.structuredContent.author).toBe('Author');
      expect(result.structuredContent.siteName).toBe('Example');
      expect(result.structuredContent.url).toBe('https://example.com');
    });

    it('calculates compressionRatio from originalTokens and convertResult', async () => {
      mockEstimateTokens.mockReturnValue(100);
      mockConvertToMarkdown.mockResolvedValue({ markdown: 'short', tokenCount: 20 });

      const result = await compressUrl({ url: 'https://example.com' });

      // (1 - 20/100) * 100 = 80
      expect(result.structuredContent.compressionRatio).toBe(80);
    });

    it('returns compressionRatio 0 when originalTokens is 0', async () => {
      mockEstimateTokens.mockReturnValue(0);

      const result = await compressUrl({ url: 'https://example.com' });

      expect(result.structuredContent.compressionRatio).toBe(0);
    });

    it('passes mode to fetchWithMode (defaults to auto)', async () => {
      await compressUrl({ url: 'https://example.com' });

      expect(mockFetchWithMode).toHaveBeenCalledWith(
        'https://example.com',
        'auto',
        expect.objectContaining({}),
      );
    });

    it('passes explicit mode to fetchWithMode', async () => {
      await compressUrl({ url: 'https://example.com', mode: 'stealth' });

      expect(mockFetchWithMode).toHaveBeenCalledWith(
        'https://example.com',
        'stealth',
        expect.objectContaining({}),
      );
    });

    it('passes timeout and maxRetries to fetchWithMode options', async () => {
      await compressUrl({ url: 'https://example.com', timeout: 5000, maxRetries: 1 });

      expect(mockFetchWithMode).toHaveBeenCalledWith(
        'https://example.com',
        'auto',
        { timeout: 5000, maxRetries: 1 },
      );
    });

    it('returns null for title/author/siteName when not extracted', async () => {
      mockExtractContent.mockResolvedValue({
        content: '<p>Content</p>',
        title: null,
        author: null,
        siteName: null,
      });

      const result = await compressUrl({ url: 'https://example.com' });

      expect(result.structuredContent.title).toBeNull();
      expect(result.structuredContent.author).toBeNull();
      expect(result.structuredContent.siteName).toBeNull();
    });
  });

  describe('telemetry', () => {
    it('reports success event with correct payload', async () => {
      await compressUrl({ url: 'https://example.com' });

      expect(mockReportScraperEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://example.com',
          tokenCount: 10,
          originalTokenCount: 100,
          title: 'Test Page',
          success: true,
        }),
      );
      expect(mockReportScraperEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          latencyMs: expect.any(Number),
        }),
      );
    });

    it('reports error event on failure', async () => {
      mockFetchWithMode.mockRejectedValue(new Error('fetch failed'));

      await compressUrl({ url: 'https://example.com' });

      expect(mockReportScraperEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://example.com',
          tokenCount: 0,
          originalTokenCount: 0,
          success: false,
          error: 'fetch failed',
        }),
      );
    });

    it('reports String(error) for non-Error thrown values', async () => {
      mockFetchWithMode.mockRejectedValue('string error');

      await compressUrl({ url: 'https://example.com' });

      expect(mockReportScraperEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'string error',
        }),
      );
    });
  });

  describe('error path', () => {
    it('returns formatError result on FetchError', async () => {
      mockFetchWithMode.mockRejectedValue(
        new MockFetchError('Forbidden', 403),
      );

      const result = await compressUrl({ url: 'https://example.com' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Access denied');
    });

    it('returns formatError result on ExtractionError', async () => {
      mockExtractContent.mockRejectedValue(
        new MockExtractionError('Empty HTML content', 'EMPTY_HTML'),
      );

      const result = await compressUrl({ url: 'https://example.com' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('empty HTML');
    });

    it('returns formatError result on generic error', async () => {
      mockConvertToMarkdown.mockRejectedValue(new Error('convert broke'));

      const result = await compressUrl({ url: 'https://example.com' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('convert broke');
    });
  });
});

describe('crawlUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockCrawlResult = {
    pages: [
      {
        markdown: '# Page 1',
        tokenCount: 5,
        title: 'Page 1',
        url: 'https://example.com',
        depth: 0,
      },
      {
        markdown: '# Page 2',
        tokenCount: 8,
        title: null,
        url: 'https://example.com/about',
        depth: 1,
      },
    ],
    totalCrawled: 2,
    totalDiscovered: 5,
    totalSkipped: 3,
    errors: [],
    duration: 1200,
  };

  describe('success path', () => {
    it('returns pages with summary', async () => {
      mockCrawl.mockResolvedValue(mockCrawlResult);

      const result = await crawlUrl({ url: 'https://example.com' });

      expect(result.content).toHaveLength(3); // summary + 2 pages
      expect(result.content[0].text).toContain('Crawled 2 pages');
      expect(result.content[0].text).toContain('example.com');
    });

    it('includes page title as header when present', async () => {
      mockCrawl.mockResolvedValue(mockCrawlResult);

      const result = await crawlUrl({ url: 'https://example.com' });

      expect(result.content[1].text).toContain('## Page 1');
      expect(result.content[1].text).toContain('# Page 1');
    });

    it('omits header when page title is null', async () => {
      mockCrawl.mockResolvedValue(mockCrawlResult);

      const result = await crawlUrl({ url: 'https://example.com' });

      // Page 2 has null title — no ## header
      expect(result.content[2].text).not.toContain('## ');
      expect(result.content[2].text).toBe('# Page 2');
    });

    it('returns structuredContent with crawl metadata', async () => {
      mockCrawl.mockResolvedValue(mockCrawlResult);

      const result = await crawlUrl({ url: 'https://example.com' });

      expect(result.structuredContent.totalCrawled).toBe(2);
      expect(result.structuredContent.totalDiscovered).toBe(5);
      expect(result.structuredContent.totalSkipped).toBe(3);
      expect(result.structuredContent.duration).toBe(1200);
      expect(result.structuredContent.errors).toHaveLength(0);
    });
  });

  describe('parameter mapping', () => {
    it('maps maxPages to limit (default 10)', async () => {
      mockCrawl.mockResolvedValue(mockCrawlResult);

      await crawlUrl({ url: 'https://example.com' });

      expect(mockCrawl).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 10 }),
      );
    });

    it('maps maxPages to limit when specified', async () => {
      mockCrawl.mockResolvedValue(mockCrawlResult);

      await crawlUrl({ url: 'https://example.com', maxPages: 25 });

      expect(mockCrawl).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 25 }),
      );
    });

    it('maps maxDepth to depth (default 2)', async () => {
      mockCrawl.mockResolvedValue(mockCrawlResult);

      await crawlUrl({ url: 'https://example.com' });

      expect(mockCrawl).toHaveBeenCalledWith(
        expect.objectContaining({ depth: 2 }),
      );
    });

    it('maps maxDepth to depth when specified', async () => {
      mockCrawl.mockResolvedValue(mockCrawlResult);

      await crawlUrl({ url: 'https://example.com', maxDepth: 0 });

      expect(mockCrawl).toHaveBeenCalledWith(
        expect.objectContaining({ depth: 0 }),
      );
    });

    it('passes include/exclude patterns through', async () => {
      mockCrawl.mockResolvedValue(mockCrawlResult);

      await crawlUrl({
        url: 'https://example.com',
        include: ['/docs/*'],
        exclude: ['/api/*'],
      });

      expect(mockCrawl).toHaveBeenCalledWith(
        expect.objectContaining({
          include: ['/docs/*'],
          exclude: ['/api/*'],
        }),
      );
    });

    it('passes mode and timeout through', async () => {
      mockCrawl.mockResolvedValue(mockCrawlResult);

      await crawlUrl({
        url: 'https://example.com',
        mode: 'render',
        timeout: 5000,
      });

      expect(mockCrawl).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'render',
          timeout: 5000,
        }),
      );
    });
  });

  describe('error summary', () => {
    it('includes singular error count in summary', async () => {
      mockCrawl.mockResolvedValue({
        ...mockCrawlResult,
        errors: [{ url: 'https://example.com/bad', error: 'fail', depth: 1 }],
      });

      const result = await crawlUrl({ url: 'https://example.com' });

      expect(result.content[0].text).toContain('(1 error)');
    });

    it('includes plural error count in summary', async () => {
      mockCrawl.mockResolvedValue({
        ...mockCrawlResult,
        errors: [
          { url: 'https://example.com/bad1', error: 'fail', depth: 1 },
          { url: 'https://example.com/bad2', error: 'fail', depth: 1 },
        ],
      });

      const result = await crawlUrl({ url: 'https://example.com' });

      expect(result.content[0].text).toContain('(2 errors)');
    });

    it('omits error suffix when no errors', async () => {
      mockCrawl.mockResolvedValue(mockCrawlResult);

      const result = await crawlUrl({ url: 'https://example.com' });

      expect(result.content[0].text).not.toContain('error');
    });
  });

  describe('error path', () => {
    it('returns formatError result on crawl failure', async () => {
      mockCrawl.mockRejectedValue(
        new MockFetchError('Connection refused', undefined, false),
      );

      const result = await crawlUrl({ url: 'https://example.com' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Connection refused');
    });

    it('does NOT call reportScraperEvent', async () => {
      mockCrawl.mockResolvedValue(mockCrawlResult);

      await crawlUrl({ url: 'https://example.com' });

      expect(mockReportScraperEvent).not.toHaveBeenCalled();
    });
  });
});
