/**
 * Layer 1c: Render Fetch
 * Playwright headless browser for JS-rendered pages (optional peer dependency)
 *
 * Uses Chromium to fully render SPAs (React, Next.js, Vue) that return
 * empty/partial HTML to tiers 1 and 2. Extracts the fully rendered DOM.
 *
 * Requires: npm install playwright
 */

import type { FetchResult } from './types.js';
import { FetchError } from './fetch.js';
import type { FetchOptions } from './fetch.js';

const DEFAULT_TIMEOUT = 30000;

function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Fetch URL using a headless Chromium browser to render JavaScript.
 *
 * Launches a fresh browser per call (no shared state), navigates to the URL,
 * waits for network idle, then extracts the fully rendered HTML.
 *
 * Playwright is an optional peer dependency — if not installed, throws a clear
 * error message with install instructions.
 */
export async function fetchRender(
  url: string,
  options: FetchOptions = {}
): Promise<FetchResult> {
  const { timeout = DEFAULT_TIMEOUT } = options;

  if (!isValidUrl(url)) {
    throw new FetchError('Invalid URL', undefined, false);
  }

  // Dynamic import — Playwright is an optional peer dependency
  let chromium: any;
  try {
    // @ts-expect-error playwright is an optional peer dependency (not installed in dev)
    ({ chromium } = await import('playwright'));
  } catch {
    throw new FetchError(
      'Playwright is required for render mode. Install: npm install playwright',
      undefined,
      false
    );
  }

  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();

    // Auto-dismiss dialogs to prevent hanging
    page.on('dialog', (dialog: any) => dialog.dismiss());

    const response = await page.goto(url, {
      waitUntil: 'networkidle',
      timeout,
    });

    if (!response) {
      throw new FetchError(
        'Navigation returned no response (about:blank or same-URL redirect)',
        undefined,
        false
      );
    }

    const statusCode = response.status();

    if (statusCode >= 400 && statusCode < 500) {
      throw new FetchError(`HTTP ${statusCode}`, statusCode, false);
    }

    if (statusCode >= 500) {
      throw new FetchError(`HTTP ${statusCode}`, statusCode, true);
    }

    const html = await page.content();
    const headers: Record<string, string> = response.headers();

    return {
      html,
      url: page.url(),
      statusCode,
      headers,
    };
  } catch (error) {
    // Convert Playwright timeout errors to retryable FetchErrors
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new FetchError('Navigation timeout', undefined, true);
    }
    throw error;
  } finally {
    await browser.close();
  }
}
