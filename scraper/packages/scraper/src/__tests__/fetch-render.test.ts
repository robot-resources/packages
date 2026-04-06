/**
 * fetch-render.ts tests
 * TKT-SCRAPER-075: Implement fetch-render.ts (tier 3 Playwright headless fetch)
 *
 * Playwright is an optional peer dependency — fully mocked in tests.
 * Tests verify: browser lifecycle, response mapping, error handling, FetchResult output.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FetchResult } from '../types.js';

// ==============================
// Mocks (vi.hoisted for vi.mock compatibility)
// ==============================

const {
  mockGoto,
  mockContent,
  mockPageUrl,
  mockClose,
  mockNewPage,
  mockLaunch,
  mockDialogDismiss,
} = vi.hoisted(() => {
  const mockDialogDismiss = vi.fn();
  const mockGoto = vi.fn();
  const mockContent = vi.fn();
  const mockPageUrl = vi.fn();
  const mockClose = vi.fn();
  const mockOn = vi.fn().mockImplementation((_event: string, cb: (dialog: any) => void) => {
    // Store dialog handler for potential testing
  });
  const mockNewPage = vi.fn().mockResolvedValue({
    goto: mockGoto,
    content: mockContent,
    url: mockPageUrl,
    on: mockOn,
  });
  const mockLaunch = vi.fn().mockResolvedValue({
    newPage: mockNewPage,
    close: mockClose,
  });

  return {
    mockGoto,
    mockContent,
    mockPageUrl,
    mockClose,
    mockNewPage,
    mockLaunch,
    mockDialogDismiss,
  };
});

vi.mock('playwright', () => ({
  chromium: {
    launch: mockLaunch,
  },
}));

import { fetchRender } from '../fetch-render.js';
import { FetchError } from '../fetch.js';

// ==============================
// Helpers
// ==============================

function mockResponse(status = 200, headers: Record<string, string> = {}) {
  return {
    status: () => status,
    headers: () => headers,
    ok: () => status >= 200 && status < 300,
  };
}

// ==============================
// Tests
// ==============================

describe('fetchRender', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset default mock implementations
    mockLaunch.mockResolvedValue({
      newPage: mockNewPage,
      close: mockClose,
    });
    mockNewPage.mockResolvedValue({
      goto: mockGoto,
      content: mockContent,
      url: mockPageUrl,
      on: vi.fn(),
    });
  });

  // ==========================================
  // Success cases
  // ==========================================

  it('returns FetchResult with rendered HTML, url, statusCode, headers', async () => {
    mockGoto.mockResolvedValueOnce(mockResponse(200, { 'content-type': 'text/html' }));
    mockContent.mockResolvedValueOnce('<html><body><div id="app">Rendered</div></body></html>');
    mockPageUrl.mockReturnValueOnce('https://example.com/spa');

    const result = await fetchRender('https://example.com/spa');

    expect(result).toEqual<FetchResult>({
      html: '<html><body><div id="app">Rendered</div></body></html>',
      url: 'https://example.com/spa',
      statusCode: 200,
      headers: { 'content-type': 'text/html' },
    });
  });

  it('launches headless Chromium browser', async () => {
    mockGoto.mockResolvedValueOnce(mockResponse());
    mockContent.mockResolvedValueOnce('<html></html>');
    mockPageUrl.mockReturnValueOnce('https://example.com');

    await fetchRender('https://example.com');

    expect(mockLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ headless: true })
    );
  });

  it('navigates with networkidle wait strategy', async () => {
    mockGoto.mockResolvedValueOnce(mockResponse());
    mockContent.mockResolvedValueOnce('<html></html>');
    mockPageUrl.mockReturnValueOnce('https://example.com');

    await fetchRender('https://example.com');

    expect(mockGoto).toHaveBeenCalledWith(
      'https://example.com',
      expect.objectContaining({ waitUntil: 'networkidle' })
    );
  });

  it('closes browser after successful fetch', async () => {
    mockGoto.mockResolvedValueOnce(mockResponse());
    mockContent.mockResolvedValueOnce('<html></html>');
    mockPageUrl.mockReturnValueOnce('https://example.com');

    await fetchRender('https://example.com');

    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  // ==========================================
  // Browser cleanup
  // ==========================================

  it('closes browser even when page.goto throws', async () => {
    mockGoto.mockRejectedValueOnce(new Error('Navigation failed'));

    await fetchRender('https://example.com').catch(() => {});

    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it('closes browser even when page.content throws', async () => {
    mockGoto.mockResolvedValueOnce(mockResponse());
    mockContent.mockRejectedValueOnce(new Error('Content extraction failed'));

    await fetchRender('https://example.com').catch(() => {});

    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  // ==========================================
  // Error handling
  // ==========================================

  it('throws FetchError on invalid URL', async () => {
    await expect(fetchRender('not-a-url')).rejects.toThrow(FetchError);
    expect(mockLaunch).not.toHaveBeenCalled();
  });

  it('throws FetchError on non-HTTP URL', async () => {
    await expect(fetchRender('ftp://example.com')).rejects.toThrow(FetchError);
    expect(mockLaunch).not.toHaveBeenCalled();
  });

  it('throws FetchError when page.goto returns null response', async () => {
    mockGoto.mockResolvedValueOnce(null);
    mockContent.mockResolvedValueOnce('<html></html>');
    mockPageUrl.mockReturnValueOnce('https://example.com');

    await expect(fetchRender('https://example.com')).rejects.toThrow(FetchError);
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it('throws FetchError with retryable=true on navigation timeout', async () => {
    const timeoutError = new Error('Timeout 10000ms exceeded');
    timeoutError.name = 'TimeoutError';
    mockGoto.mockRejectedValueOnce(timeoutError);

    const error = await fetchRender('https://example.com').catch((e: FetchError) => e);

    expect(error).toBeInstanceOf(FetchError);
    expect(error.retryable).toBe(true);
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  // ==========================================
  // HTTP error responses
  // ==========================================

  it('throws FetchError on HTTP 404 (not retryable)', async () => {
    mockGoto.mockResolvedValueOnce(mockResponse(404));
    mockPageUrl.mockReturnValueOnce('https://example.com');

    const error = await fetchRender('https://example.com').catch((e: FetchError) => e);

    expect(error).toBeInstanceOf(FetchError);
    expect(error.statusCode).toBe(404);
    expect(error.retryable).toBe(false);
  });

  it('throws FetchError on HTTP 500 (retryable)', async () => {
    mockGoto.mockResolvedValueOnce(mockResponse(500));
    mockPageUrl.mockReturnValueOnce('https://example.com');

    const error = await fetchRender('https://example.com').catch((e: FetchError) => e);

    expect(error).toBeInstanceOf(FetchError);
    expect(error.statusCode).toBe(500);
    expect(error.retryable).toBe(true);
  });

  // ==========================================
  // Timeout
  // ==========================================

  it('passes timeout to page.goto', async () => {
    mockGoto.mockResolvedValueOnce(mockResponse());
    mockContent.mockResolvedValueOnce('<html></html>');
    mockPageUrl.mockReturnValueOnce('https://example.com');

    await fetchRender('https://example.com', { timeout: 5000 });

    expect(mockGoto).toHaveBeenCalledWith(
      'https://example.com',
      expect.objectContaining({ timeout: 5000 })
    );
  });

  it('uses default timeout of 30000ms', async () => {
    mockGoto.mockResolvedValueOnce(mockResponse());
    mockContent.mockResolvedValueOnce('<html></html>');
    mockPageUrl.mockReturnValueOnce('https://example.com');

    await fetchRender('https://example.com');

    expect(mockGoto).toHaveBeenCalledWith(
      'https://example.com',
      expect.objectContaining({ timeout: 30000 })
    );
  });
});
