/**
 * Layer 1: Fetch
 * HTTP fetching with smart headers and retries
 */

import type { FetchResult } from './types.js';

const USER_AGENTS = [
  'Mozilla/5.0 (compatible; ScraperBot/1.0; +https://scraper.robotresources.ai)',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
];

const DEFAULT_TIMEOUT = 10000;
const DEFAULT_MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1000;

export interface FetchOptions {
  timeout?: number;
  maxRetries?: number;
  userAgent?: string;
}

/**
 * Error class for fetch-related errors
 */
export class FetchError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly retryable: boolean = false
  ) {
    super(message);
    this.name = 'FetchError';
  }
}

function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function getRandomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function buildHeaders(userAgent?: string): Record<string, string> {
  return {
    'User-Agent': userAgent || getRandomUserAgent(),
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate',
    Connection: 'keep-alive',
    'Cache-Control': 'no-cache',
  };
}

function headersToObject(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key.toLowerCase()] = value;
  });
  return result;
}

function isRetryableStatus(status: number): boolean {
  return status >= 500 && status < 600;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getBackoffDelay(attempt: number): number {
  return BASE_BACKOFF_MS * Math.pow(2, attempt);
}

async function fetchWithTimeout(
  url: string,
  headers: Record<string, string>,
  timeout: number
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
      redirect: 'follow',
    });
    return response;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new FetchError('Request timeout', undefined, true);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Fetch URL content with smart headers and retry logic
 */
export async function fetchUrl(
  url: string,
  options: FetchOptions = {}
): Promise<FetchResult> {
  const {
    timeout = DEFAULT_TIMEOUT,
    maxRetries = DEFAULT_MAX_RETRIES,
    userAgent,
  } = options;

  if (!isValidUrl(url)) {
    throw new FetchError('Invalid URL', undefined, false);
  }

  const headers = buildHeaders(userAgent);
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetchWithTimeout(url, headers, timeout);

      if (!response.ok) {
        const statusCode = response.status;

        if (statusCode >= 400 && statusCode < 500) {
          throw new FetchError(`HTTP ${statusCode}`, statusCode, false);
        }

        if (isRetryableStatus(statusCode)) {
          throw new FetchError(`HTTP ${statusCode}`, statusCode, true);
        }
      }

      const html = await response.text();
      const responseHeaders = headersToObject(response.headers);

      return {
        html,
        url: response.url,
        statusCode: response.status,
        headers: responseHeaders,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      const isRetryable =
        error instanceof FetchError
          ? error.retryable
          : !(error instanceof FetchError);

      const hasRetriesLeft = attempt < maxRetries;

      if (isRetryable && hasRetriesLeft) {
        const delay = getBackoffDelay(attempt);
        await sleep(delay);
        continue;
      }

      break;
    }
  }

  throw lastError || new FetchError('Unknown fetch error');
}
