/**
 * Layer 1b: Stealth Fetch
 * TLS fingerprint impersonation via impit (optional peer dependency)
 *
 * Uses Rust-based browser TLS fingerprinting to bypass anti-bot systems
 * (Cloudflare, Akamai, PerimeterX) without a full browser.
 *
 * Requires: npm install impit (Node >= 20)
 */

import type { FetchResult } from './types.js';
import { FetchError } from './fetch.js';
import type { FetchOptions } from './fetch.js';

const DEFAULT_TIMEOUT = 10000;
const DEFAULT_MAX_RETRIES = 2;
const BASE_BACKOFF_MS = 1000;

function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
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

/**
 * Fetch URL with browser TLS fingerprint impersonation.
 *
 * Uses impit (Apify) to produce Chrome-like JA3/JA4 fingerprints at the
 * TLS handshake level. This bypasses anti-bot systems that reject default
 * Node.js TLS signatures.
 *
 * impit is an optional peer dependency — if not installed, throws a clear
 * error message with install instructions.
 */
export async function fetchStealth(
  url: string,
  options: FetchOptions = {}
): Promise<FetchResult> {
  const {
    timeout = DEFAULT_TIMEOUT,
    maxRetries = DEFAULT_MAX_RETRIES,
  } = options;

  if (!isValidUrl(url)) {
    throw new FetchError('Invalid URL', undefined, false);
  }

  // Dynamic import — impit is an optional peer dependency
  let Impit: any;
  try {
    // @ts-expect-error impit is an optional peer dependency (not installed in dev)
    ({ Impit } = await import('impit'));
  } catch {
    throw new FetchError(
      'impit is required for stealth mode. Install: npm install impit (requires Node >= 20)',
      undefined,
      false
    );
  }

  const client = new Impit({ browser: 'chrome' });
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await client.fetch(url, {
        signal: AbortSignal.timeout(timeout),
      });

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
      const headers: Record<string, string> = {};
      response.headers.forEach((value: string, key: string) => {
        headers[key] = value;
      });

      return {
        html,
        url: response.url ?? url,
        statusCode: response.status,
        headers,
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

  throw lastError || new FetchError('Unknown stealth fetch error');
}
