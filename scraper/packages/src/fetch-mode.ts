/**
 * Mode-aware fetch routing with challenge detection.
 *
 * Shared between scrape() (index.ts) and crawl() (crawl.ts)
 * to avoid duplicating mode routing and challenge detection logic.
 */

import type { FetchResult, FetchMode } from './types.js';
import type { FetchOptions } from './fetch.js';
import { fetchUrl, FetchError } from './fetch.js';
import { fetchStealth } from './fetch-stealth.js';
import { fetchRender } from './fetch-render.js';
import { pushDebugEntry } from './debug.js';

const CHALLENGE_MARKERS = [
  'cf-browser-verification',
  'Just a moment',
  '_cf_chl_opt',
  'akamai-challenge',
  'ak-challenge',
];

/**
 * Detect anti-bot challenge pages that return HTTP 200 but contain
 * challenge/verification HTML instead of real content.
 */
export function isChallengeResponse(fetchResult: FetchResult): boolean {
  return CHALLENGE_MARKERS.some(marker => fetchResult.html.includes(marker));
}

/**
 * Fetch a URL using the specified mode with auto-fallback support.
 *
 * Modes:
 * - 'fast': Tier 1 only (plain HTTP)
 * - 'stealth': Tier 2 only (TLS fingerprint)
 * - 'render': Tier 3 only (Playwright)
 * - 'auto': Fast first, fall back to stealth on 403 or challenge page
 */
const VALID_MODES: readonly string[] = ['fast', 'stealth', 'render', 'auto'];

export async function fetchWithMode(
  url: string,
  mode: FetchMode,
  options: FetchOptions,
): Promise<FetchResult> {
  if (!VALID_MODES.includes(mode)) {
    throw new FetchError(
      `Invalid fetch mode: '${mode}'. Valid modes: ${VALID_MODES.join(', ')}`,
      undefined,
      false,
    );
  }

  if (mode === 'stealth') return fetchStealth(url, options);
  if (mode === 'render') return fetchRender(url, options);
  if (mode === 'fast') return fetchUrl(url, options);

  // auto: fast with fallback to stealth on 403, challenge, TLS/network errors
  try {
    const result = await fetchUrl(url, options);
    if (isChallengeResponse(result)) {
      pushDebugEntry('scraper-fetch-modes', {
        url, requested_mode: 'auto', selected_mode: 'stealth', reason: 'challenge page detected',
      });
      return fetchStealth(url, options);
    }
    pushDebugEntry('scraper-fetch-modes', {
      url, requested_mode: 'auto', selected_mode: 'fast', reason: 'fast succeeded',
    });
    return result;
  } catch (err) {
    // Fall back to stealth on:
    // - 403 (anti-bot block)
    // - TLS/SSL errors (e.g. UNABLE_TO_GET_ISSUER_CERT_LOCALLY)
    // - Network failures (ECONNREFUSED, ENOTFOUND, etc.)
    // Stealth uses impit with its own TLS stack, bypassing Node.js cert issues.
    //
    // Do NOT fall back on other HTTP errors (404, 500, etc.) — those are real.
    if (err instanceof FetchError) {
      if (err.statusCode === 403) {
        pushDebugEntry('scraper-fetch-modes', {
          url, requested_mode: 'auto', selected_mode: 'stealth', reason: 'HTTP 403 fallback',
        });
        return fetchStealth(url, options);
      }
      throw err;
    }
    // Non-FetchError = TLS/network issue → fall back to stealth
    pushDebugEntry('scraper-fetch-modes', {
      url, requested_mode: 'auto', selected_mode: 'stealth',
      reason: `TLS/network error: ${err instanceof Error ? err.message : String(err)}`,
    });
    return fetchStealth(url, options);
  }
}
