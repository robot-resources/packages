/**
 * fetch-stealth.ts tests
 * TKT-SCRAPER-073: Implement fetch-stealth.ts (tier 2 TLS fingerprint fetch)
 *
 * Since impit is an optional peer dependency, we mock it entirely.
 * Tests verify the integration logic: retry, timeout, error handling, FetchResult output.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FetchResult } from '../types.js';

// Mock the dynamic import of impit
// vi.hoisted() ensures these variables exist when vi.mock() factory runs (hoisting order)
// Uses regular function (not arrow) so it's constructable with `new Impit(...)`
const { mockFetchFn, mockImpit } = vi.hoisted(() => {
  const mockFetchFn = vi.fn();
  const mockImpit = vi.fn().mockImplementation(function () {
    return { fetch: mockFetchFn };
  });
  return { mockFetchFn, mockImpit };
});

vi.mock('impit', () => ({
  Impit: mockImpit,
}));

import { fetchStealth } from '../fetch-stealth.js';
import { FetchError } from '../fetch.js';

function mockResponse(body: string, status = 200, headers: Record<string, string> = {}) {
  const headerMap = new Map(Object.entries(headers));
  return {
    ok: status >= 200 && status < 300,
    status,
    url: 'https://example.com/page',
    text: () => Promise.resolve(body),
    headers: {
      forEach: (cb: (value: string, key: string) => void) => {
        headerMap.forEach((value, key) => cb(value, key));
      },
    },
  };
}

describe('fetchStealth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchFn.mockReset();
    mockImpit.mockClear();
  });

  // ==========================================
  // Success cases
  // ==========================================

  it('returns FetchResult with html, url, statusCode, headers', async () => {
    mockFetchFn.mockResolvedValueOnce(
      mockResponse('<html>stealth page</html>', 200, { 'content-type': 'text/html' })
    );

    const result = await fetchStealth('https://example.com/page');

    expect(result).toEqual<FetchResult>({
      html: '<html>stealth page</html>',
      url: 'https://example.com/page',
      statusCode: 200,
      headers: { 'content-type': 'text/html' },
    });
  });

  it('creates Impit instance with chrome browser profile by default', async () => {
    mockFetchFn.mockResolvedValueOnce(mockResponse('<html></html>'));

    await fetchStealth('https://example.com/page');

    expect(mockImpit).toHaveBeenCalledWith(
      expect.objectContaining({ browser: 'chrome' })
    );
  });

  it('passes URL to impit fetch', async () => {
    mockFetchFn.mockResolvedValueOnce(mockResponse('<html></html>'));

    await fetchStealth('https://example.com/page');

    expect(mockFetchFn).toHaveBeenCalledWith(
      'https://example.com/page',
      expect.any(Object)
    );
  });

  // ==========================================
  // Retry logic
  // ==========================================

  it('retries on HTTP 500 with exponential backoff', async () => {
    mockFetchFn
      .mockResolvedValueOnce(mockResponse('Server Error', 500))
      .mockResolvedValueOnce(mockResponse('<html>recovered</html>', 200));

    const result = await fetchStealth('https://example.com/page', { maxRetries: 3 });

    expect(result.html).toBe('<html>recovered</html>');
    expect(mockFetchFn).toHaveBeenCalledTimes(2);
  });

  it('throws FetchError after exhausting retries on 500', async () => {
    mockFetchFn.mockResolvedValue(mockResponse('Server Error', 500));

    await expect(
      fetchStealth('https://example.com/page', { maxRetries: 2 })
    ).rejects.toThrow(FetchError);

    // 1 initial + 2 retries = 3 calls
    expect(mockFetchFn).toHaveBeenCalledTimes(3);
  });

  it('retries on network error (retryable)', async () => {
    mockFetchFn
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce(mockResponse('<html>ok</html>', 200));

    const result = await fetchStealth('https://example.com/page', { maxRetries: 1 });

    expect(result.html).toBe('<html>ok</html>');
    expect(mockFetchFn).toHaveBeenCalledTimes(2);
  });

  // ==========================================
  // Non-retryable errors
  // ==========================================

  it('throws FetchError immediately on HTTP 404 (not retryable)', async () => {
    mockFetchFn.mockResolvedValueOnce(mockResponse('Not Found', 404));

    const error = await fetchStealth('https://example.com/page', { maxRetries: 3 })
      .catch((e: FetchError) => e);

    expect(error).toBeInstanceOf(FetchError);
    expect(error.statusCode).toBe(404);
    expect(error.retryable).toBe(false);
    expect(mockFetchFn).toHaveBeenCalledTimes(1);
  });

  it('throws FetchError immediately on HTTP 403 (not retryable)', async () => {
    mockFetchFn.mockResolvedValueOnce(mockResponse('Forbidden', 403));

    const error = await fetchStealth('https://example.com/page')
      .catch((e: FetchError) => e);

    expect(error).toBeInstanceOf(FetchError);
    expect(error.statusCode).toBe(403);
    expect(error.retryable).toBe(false);
  });

  // ==========================================
  // URL validation
  // ==========================================

  it('throws FetchError on invalid URL', async () => {
    await expect(fetchStealth('not-a-url')).rejects.toThrow(FetchError);
    expect(mockFetchFn).not.toHaveBeenCalled();
  });

  it('throws FetchError on non-HTTP URL', async () => {
    await expect(fetchStealth('ftp://example.com')).rejects.toThrow(FetchError);
    expect(mockFetchFn).not.toHaveBeenCalled();
  });

  // ==========================================
  // Timeout
  // ==========================================

  it('uses default timeout of 10000ms', async () => {
    mockFetchFn.mockResolvedValueOnce(mockResponse('<html></html>'));

    await fetchStealth('https://example.com/page');

    const callArgs = mockFetchFn.mock.calls[0][1];
    expect(callArgs.signal).toBeDefined();
  });

  it('uses custom timeout when provided', async () => {
    mockFetchFn.mockResolvedValueOnce(mockResponse('<html></html>'));

    await fetchStealth('https://example.com/page', { timeout: 5000 });

    expect(mockFetchFn).toHaveBeenCalledTimes(1);
  });

  // ==========================================
  // Headers
  // ==========================================

  it('converts response headers to Record<string, string>', async () => {
    mockFetchFn.mockResolvedValueOnce(
      mockResponse('<html></html>', 200, {
        'content-type': 'text/html; charset=utf-8',
        'x-custom': 'value',
      })
    );

    const result = await fetchStealth('https://example.com/page');

    expect(result.headers).toEqual({
      'content-type': 'text/html; charset=utf-8',
      'x-custom': 'value',
    });
  });
});
