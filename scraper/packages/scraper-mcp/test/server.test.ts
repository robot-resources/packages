/**
 * scraper-mcp server tests
 * TKT-SCRAPER-065: Build scraper-mcp MCP Server
 *
 * Tests mock @robot-resources/scraper at the fetchWithMode boundary.
 * Mode routing logic (auto-fallback, challenge detection) is the scraper
 * package's responsibility — tested there, not here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist mock definitions so vi.mock factory can reference them
const {
  mockFetchWithMode,
  mockExtractContent,
  mockConvertToMarkdown,
  mockEstimateTokens,
  mockCrawl,
  MockFetchError,
  MockExtractionError,
} = vi.hoisted(() => {
  class _MockFetchError extends Error {
    statusCode?: number;
    retryable: boolean;
    constructor(message: string, statusCode?: number, retryable = false) {
      super(message);
      this.name = 'FetchError';
      this.statusCode = statusCode;
      this.retryable = retryable;
    }
  }

  class _MockExtractionError extends Error {
    code: string;
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
    MockFetchError: _MockFetchError,
    MockExtractionError: _MockExtractionError,
  };
});

vi.mock('@robot-resources/scraper', () => ({
  fetchWithMode: (...args: unknown[]) => mockFetchWithMode(...args),
  extractContent: (...args: unknown[]) => mockExtractContent(...args),
  convertToMarkdown: (...args: unknown[]) => mockConvertToMarkdown(...args),
  estimateTokens: (...args: unknown[]) => mockEstimateTokens(...args),
  crawl: (...args: unknown[]) => mockCrawl(...args),
  FetchError: MockFetchError,
  ExtractionError: MockExtractionError,
}));

import { compressUrl, crawlUrl, formatError, createServer } from '../src/server.js';

describe('scraper-mcp server', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createServer', () => {
    it('should create an McpServer instance', () => {
      const server = createServer();
      expect(server).toBeDefined();
    });
  });

  describe('compressUrl', () => {
    const testUrl = 'https://example.com/article';

    describe('successful compression', () => {
      beforeEach(() => {
        mockFetchWithMode.mockResolvedValue({
          html: '<html><body><article><h1>Test Article</h1><p>Content here with enough text to be meaningful for extraction purposes.</p></article></body></html>',
          url: testUrl,
          statusCode: 200,
          headers: { 'content-type': 'text/html' },
        });
        mockEstimateTokens.mockReturnValue(1000);
        mockExtractContent.mockResolvedValue({
          content: '<h1>Test Article</h1><p>Content here.</p>',
          title: 'Test Article',
          author: 'Test Author',
          siteName: 'Example',
        });
        mockConvertToMarkdown.mockResolvedValue({
          markdown: '# Test Article\n\nContent here.',
          tokenCount: 250,
        });
      });

      it('should return compressed markdown as text content', async () => {
        const result = await compressUrl({ url: testUrl });

        expect(result.content).toHaveLength(1);
        expect(result.content[0].type).toBe('text');
        expect(result.content[0].text).toBe('# Test Article\n\nContent here.');
      });

      it('should return structured content with metadata', async () => {
        const result = await compressUrl({ url: testUrl });

        expect(result.structuredContent).toEqual({
          markdown: '# Test Article\n\nContent here.',
          tokenCount: 250,
          title: 'Test Article',
          author: 'Test Author',
          siteName: 'Example',
          url: testUrl,
          compressionRatio: 75,
        });
      });

      it('should calculate compression ratio correctly', async () => {
        mockEstimateTokens.mockReturnValue(2000);
        mockConvertToMarkdown.mockResolvedValue({
          markdown: '# Short',
          tokenCount: 400,
        });

        const result = await compressUrl({ url: testUrl });

        // (1 - 400/2000) * 100 = 80%
        expect(result.structuredContent?.compressionRatio).toBe(80);
      });

      it('should handle zero original tokens without division error', async () => {
        mockEstimateTokens.mockReturnValue(0);

        const result = await compressUrl({ url: testUrl });

        expect(result.structuredContent?.compressionRatio).toBe(0);
      });

      it('should pass options to fetchWithMode', async () => {
        await compressUrl({ url: testUrl, timeout: 5000, maxRetries: 1 });

        expect(mockFetchWithMode).toHaveBeenCalledWith(testUrl, 'auto', {
          timeout: 5000,
          maxRetries: 1,
        });
      });

      it('should use undefined for optional params when not provided', async () => {
        await compressUrl({ url: testUrl });

        expect(mockFetchWithMode).toHaveBeenCalledWith(testUrl, 'auto', {
          timeout: undefined,
          maxRetries: undefined,
        });
      });

      it('should handle missing optional metadata gracefully', async () => {
        mockExtractContent.mockResolvedValue({
          content: '<p>Minimal content</p>',
        });

        const result = await compressUrl({ url: testUrl });

        expect(result.structuredContent?.title).toBeNull();
        expect(result.structuredContent?.author).toBeNull();
        expect(result.structuredContent?.siteName).toBeNull();
      });

      it('should use the final URL from fetchResult (redirect handling)', async () => {
        const redirectedUrl = 'https://example.com/final-page';
        mockFetchWithMode.mockResolvedValue({
          html: '<html><body>test</body></html>',
          url: redirectedUrl,
          statusCode: 200,
          headers: {},
        });

        const result = await compressUrl({ url: testUrl });

        expect(result.structuredContent?.url).toBe(redirectedUrl);
      });

      it('should not have isError on success', async () => {
        const result = await compressUrl({ url: testUrl });

        expect(result).not.toHaveProperty('isError');
      });

      it('should call pipeline in correct order', async () => {
        const callOrder: string[] = [];
        mockFetchWithMode.mockImplementation(async () => {
          callOrder.push('fetch');
          return {
            html: '<html>test</html>',
            url: testUrl,
            statusCode: 200,
            headers: {},
          };
        });
        mockEstimateTokens.mockImplementation(() => {
          callOrder.push('estimateTokens');
          return 100;
        });
        mockExtractContent.mockImplementation(async () => {
          callOrder.push('extract');
          return { content: '<p>test</p>' };
        });
        mockConvertToMarkdown.mockImplementation(async () => {
          callOrder.push('convert');
          return { markdown: 'test', tokenCount: 10 };
        });

        await compressUrl({ url: testUrl });

        expect(callOrder).toEqual([
          'fetch',
          'estimateTokens',
          'extract',
          'convert',
        ]);
      });
    });

    describe('FetchError handling', () => {
      it('should return actionable message for HTTP 403', async () => {
        mockFetchWithMode.mockRejectedValue(
          new MockFetchError('HTTP 403', 403, false),
        );

        const result = await compressUrl({ url: testUrl });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Access denied (HTTP 403)');
        expect(result.content[0].text).toContain(testUrl);
        expect(result.content[0].text).toContain('authentication');
      });

      it('should return actionable message for HTTP 404', async () => {
        mockFetchWithMode.mockRejectedValue(
          new MockFetchError('HTTP 404', 404, false),
        );

        const result = await compressUrl({ url: testUrl });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Page not found (HTTP 404)');
        expect(result.content[0].text).toContain('Verify the URL');
      });

      it('should return actionable message for HTTP 500', async () => {
        mockFetchWithMode.mockRejectedValue(
          new MockFetchError('HTTP 500', 500, true),
        );

        const result = await compressUrl({ url: testUrl });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Server error (HTTP 500)');
        expect(result.content[0].text).toContain('Try again later');
      });

      it('should return actionable message for HTTP 502', async () => {
        mockFetchWithMode.mockRejectedValue(
          new MockFetchError('HTTP 502', 502, true),
        );

        const result = await compressUrl({ url: testUrl });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Server error (HTTP 502)');
      });

      it('should return actionable message for timeout', async () => {
        mockFetchWithMode.mockRejectedValue(
          new MockFetchError('Request timeout after 10000ms', undefined, true),
        );

        const result = await compressUrl({ url: testUrl });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('timed out');
        expect(result.content[0].text).toContain('timeout parameter');
      });

      it('should return actionable message for invalid URL', async () => {
        mockFetchWithMode.mockRejectedValue(
          new MockFetchError('Invalid URL: bad-url', undefined, false),
        );

        const result = await compressUrl({ url: 'bad-url' });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Invalid URL');
        expect(result.content[0].text).toContain('http://');
      });

      it('should include retry hint for retryable errors', async () => {
        mockFetchWithMode.mockRejectedValue(
          new MockFetchError('Connection reset', undefined, true),
        );

        const result = await compressUrl({ url: testUrl });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Retries exhausted');
      });

      it('should not include retry hint for non-retryable errors', async () => {
        mockFetchWithMode.mockRejectedValue(
          new MockFetchError('DNS not found', undefined, false),
        );

        const result = await compressUrl({ url: testUrl });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).not.toContain('Retries exhausted');
      });
    });

    describe('ExtractionError handling', () => {
      beforeEach(() => {
        mockFetchWithMode.mockResolvedValue({
          html: '<html></html>',
          url: testUrl,
          statusCode: 200,
          headers: {},
        });
        mockEstimateTokens.mockReturnValue(100);
      });

      it('should return actionable message for EMPTY_HTML', async () => {
        mockExtractContent.mockRejectedValue(
          new MockExtractionError('Empty HTML document', 'EMPTY_HTML'),
        );

        const result = await compressUrl({ url: testUrl });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('empty HTML');
        expect(result.content[0].text).toContain('JavaScript rendering');
        expect(result.content[0].text).toContain("mode: 'render'");
        expect(result.content[0].text).toContain('static HTML');
      });

      it('should return actionable message for NO_CONTENT', async () => {
        mockExtractContent.mockRejectedValue(
          new MockExtractionError(
            'No meaningful content found',
            'NO_CONTENT',
          ),
        );

        const result = await compressUrl({ url: testUrl });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain(
          'Could not extract meaningful content',
        );
        expect(result.content[0].text).toContain('login wall');
      });

      it('should handle unknown extraction error codes', async () => {
        mockExtractContent.mockRejectedValue(
          new MockExtractionError('Something else', 'UNKNOWN_CODE'),
        );

        const result = await compressUrl({ url: testUrl });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain(
          'Content extraction failed',
        );
        expect(result.content[0].text).toContain('Something else');
      });
    });

    describe('mode routing', () => {
      const goodFetch = {
        html: '<html><body><h1>Content</h1></body></html>',
        url: 'https://example.com/article',
        statusCode: 200,
        headers: { 'content-type': 'text/html' },
      };

      beforeEach(() => {
        mockFetchWithMode.mockResolvedValue(goodFetch);
        mockEstimateTokens.mockReturnValue(500);
        mockExtractContent.mockResolvedValue({ content: '<h1>Content</h1>', title: 'Content' });
        mockConvertToMarkdown.mockResolvedValue({ markdown: '# Content', tokenCount: 3 });
      });

      it("passes 'fast' mode to fetchWithMode", async () => {
        await compressUrl({ url: testUrl, mode: 'fast' });

        expect(mockFetchWithMode).toHaveBeenCalledWith(testUrl, 'fast', expect.any(Object));
      });

      it("passes 'stealth' mode to fetchWithMode", async () => {
        await compressUrl({ url: testUrl, mode: 'stealth' });

        expect(mockFetchWithMode).toHaveBeenCalledWith(testUrl, 'stealth', expect.any(Object));
      });

      it("passes 'render' mode to fetchWithMode", async () => {
        await compressUrl({ url: testUrl, mode: 'render' });

        expect(mockFetchWithMode).toHaveBeenCalledWith(testUrl, 'render', expect.any(Object));
      });

      it("defaults to 'auto' when mode not specified", async () => {
        await compressUrl({ url: testUrl });

        expect(mockFetchWithMode).toHaveBeenCalledWith(testUrl, 'auto', expect.any(Object));
      });

      it('passes timeout and maxRetries to fetchWithMode', async () => {
        await compressUrl({ url: testUrl, mode: 'stealth', timeout: 5000, maxRetries: 2 });

        expect(mockFetchWithMode).toHaveBeenCalledWith(testUrl, 'stealth', {
          timeout: 5000,
          maxRetries: 2,
        });
      });
    });

    describe('unexpected error handling', () => {
      it('should handle generic Error instances', async () => {
        mockFetchWithMode.mockRejectedValue(new Error('Something broke'));

        const result = await compressUrl({ url: testUrl });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Unexpected error');
        expect(result.content[0].text).toContain('Something broke');
      });

      it('should handle non-Error thrown values', async () => {
        mockFetchWithMode.mockRejectedValue('string error');

        const result = await compressUrl({ url: testUrl });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('string error');
      });

      it('should always include the URL in error messages', async () => {
        mockFetchWithMode.mockRejectedValue(new Error('fail'));

        const result = await compressUrl({ url: testUrl });

        expect(result.content[0].text).toContain(testUrl);
      });
    });
  });

  describe('crawlUrl', () => {
    const testUrl = 'https://docs.example.com';

    const mockCrawlResult = {
      pages: [
        {
          markdown: '# Home\n\nWelcome to docs.',
          tokenCount: 10,
          title: 'Home',
          author: null,
          siteName: 'Docs',
          publishedAt: null,
          url: 'https://docs.example.com',
          depth: 0,
        },
        {
          markdown: '# Getting Started\n\nStep 1: Install.',
          tokenCount: 15,
          title: 'Getting Started',
          author: null,
          siteName: 'Docs',
          publishedAt: null,
          url: 'https://docs.example.com/getting-started',
          depth: 1,
        },
        {
          markdown: '# API Reference\n\nEndpoints listed here.',
          tokenCount: 12,
          title: 'API Reference',
          author: null,
          siteName: 'Docs',
          publishedAt: null,
          url: 'https://docs.example.com/api',
          depth: 1,
        },
      ],
      totalDiscovered: 10,
      totalCrawled: 3,
      totalSkipped: 7,
      errors: [],
      duration: 1500,
    };

    describe('successful crawl', () => {
      beforeEach(() => {
        mockCrawl.mockResolvedValue(mockCrawlResult);
      });

      it('should return summary as first content item', async () => {
        const result = await crawlUrl({ url: testUrl });

        expect(result.content[0].type).toBe('text');
        expect(result.content[0].text).toContain('3 pages');
        expect(result.content[0].text).toContain('docs.example.com');
      });

      it('should return per-page markdown in content array', async () => {
        const result = await crawlUrl({ url: testUrl });

        // summary + 3 pages = 4 content items
        expect(result.content).toHaveLength(4);
        expect(result.content[1].text).toContain('# Home');
        expect(result.content[2].text).toContain('# Getting Started');
        expect(result.content[3].text).toContain('# API Reference');
      });

      it('should include structuredContent with crawl data', async () => {
        const result = await crawlUrl({ url: testUrl });

        expect(result.structuredContent).toBeDefined();
        expect(result.structuredContent.totalCrawled).toBe(3);
        expect(result.structuredContent.totalDiscovered).toBe(10);
        expect(result.structuredContent.duration).toBe(1500);
        expect(result.structuredContent.pages).toHaveLength(3);
        expect(result.structuredContent.errors).toEqual([]);
      });

      it('should map MCP params to CrawlOptions correctly', async () => {
        await crawlUrl({
          url: testUrl,
          maxPages: 20,
          maxDepth: 3,
          mode: 'stealth',
          include: ['**/api/**'],
          exclude: ['**/internal/**'],
          timeout: 5000,
        });

        expect(mockCrawl).toHaveBeenCalledWith({
          url: testUrl,
          limit: 20,
          depth: 3,
          mode: 'stealth',
          include: ['**/api/**'],
          exclude: ['**/internal/**'],
          timeout: 5000,
        });
      });

      it('should use defaults when optional params omitted', async () => {
        await crawlUrl({ url: testUrl });

        expect(mockCrawl).toHaveBeenCalledWith(
          expect.objectContaining({
            url: testUrl,
            limit: 10,
            depth: 2,
          }),
        );
      });

      it('should not have isError on success', async () => {
        const result = await crawlUrl({ url: testUrl });

        expect(result).not.toHaveProperty('isError');
      });
    });

    describe('crawl with errors', () => {
      it('should include error summary in output when pages have errors', async () => {
        mockCrawl.mockResolvedValue({
          ...mockCrawlResult,
          errors: [
            { url: 'https://docs.example.com/broken', error: 'HTTP 500', depth: 1 },
          ],
        });

        const result = await crawlUrl({ url: testUrl });

        expect(result.content[0].text).toContain('1 error');
        expect(result.structuredContent.errors).toHaveLength(1);
      });

      it('should return informative message when crawl returns 0 pages', async () => {
        mockCrawl.mockResolvedValue({
          pages: [],
          totalDiscovered: 1,
          totalCrawled: 0,
          totalSkipped: 1,
          errors: [],
          duration: 200,
        });

        const result = await crawlUrl({ url: testUrl });

        expect(result.content[0].text).toContain('0 pages');
        expect(result.content).toHaveLength(1); // only summary, no page content
      });

      it('should return isError when crawl() throws', async () => {
        mockCrawl.mockRejectedValue(
          new MockFetchError('Invalid URL', undefined, false),
        );

        const result = await crawlUrl({ url: testUrl });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Invalid URL');
      });

      it('should handle generic errors from crawl()', async () => {
        mockCrawl.mockRejectedValue(new Error('Network failure'));

        const result = await crawlUrl({ url: testUrl });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Network failure');
      });
    });
  });

  describe('formatError', () => {
    const url = 'https://test.com';

    it('should always return isError: true', () => {
      const result = formatError(url, new Error('test'));
      expect(result.isError).toBe(true);
    });

    it('should always return text content', () => {
      const result = formatError(url, new Error('test'));
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
    });

    it('should handle FetchError with status code', () => {
      const result = formatError(
        url,
        new MockFetchError('HTTP 429', 429, true),
      );
      expect(result.content[0].text).toContain('Failed to fetch');
      expect(result.content[0].text).toContain('Retries exhausted');
    });

    it('should handle ExtractionError', () => {
      const result = formatError(
        url,
        new MockExtractionError('No content', 'NO_CONTENT'),
      );
      expect(result.content[0].text).toContain('meaningful content');
    });

    it('should handle null/undefined errors', () => {
      const result = formatError(url, null);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('null');
    });
  });
});
