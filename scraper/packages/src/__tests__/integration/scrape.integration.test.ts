/**
 * Integration tests — real HTTP requests against stable public URLs.
 *
 * Run:  npm run test:integration
 * NOT included in CI (network-dependent, slower).
 */

import { describe, it, expect } from 'vitest';
import { scrape } from '../../index.js';
import type { ScrapeResult } from '../../types.js';

const STABLE_URLS = [
  {
    url: 'https://en.wikipedia.org/wiki/TypeScript',
    label: 'Wikipedia — TypeScript',
    expectTitle: /typescript/i,
    expectContains: ['microsoft', 'programming language'],
    minTokens: 100,
    maxTokens: 50000,
  },
  {
    url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array',
    label: 'MDN — Array',
    expectTitle: /array/i,
    expectContains: ['array', 'prototype'],
    minTokens: 100,
    maxTokens: 50000,
  },
  {
    url: 'https://www.rfc-editor.org/rfc/rfc2616',
    label: 'RFC 2616 — HTTP/1.1',
    expectTitle: /http|rfc/i,
    expectContains: ['request', 'response'],
    minTokens: 100,
    maxTokens: 200000,
  },
];

describe('Integration: scrape() with real URLs', () => {
  describe.each(STABLE_URLS)(
    '$label',
    ({ url, expectTitle, expectContains, minTokens, maxTokens }) => {
      let result: ScrapeResult;

      it('should scrape successfully', async () => {
        result = await scrape(url, { timeout: 15000, maxRetries: 2 });

        expect(result).toBeDefined();
        expect(result.markdown).toBeTruthy();
        expect(result.markdown.length).toBeGreaterThan(100);
      });

      it('should have a valid title', () => {
        expect(result.title).toBeTruthy();
        expect(result.title).toMatch(expectTitle);
      });

      it('should have a reasonable token count', () => {
        expect(result.tokenCount).toBeGreaterThanOrEqual(minTokens);
        expect(result.tokenCount).toBeLessThanOrEqual(maxTokens);
      });

      it('should contain expected content', () => {
        const lower = result.markdown.toLowerCase();
        for (const phrase of expectContains) {
          expect(lower).toContain(phrase.toLowerCase());
        }
      });

      it('should return well-formed markdown', () => {
        // Should have some markdown structure (headings or links)
        const hasHeadings = /^#+\s/m.test(result.markdown);
        const hasLinks = /\[.*?\]\(.*?\)/.test(result.markdown);
        expect(hasHeadings || hasLinks).toBe(true);
        // Should not contain raw HTML block elements
        expect(result.markdown).not.toMatch(/<(div|span|script|style)\b/i);
      });

      it('should return the final URL', () => {
        expect(result.url).toBeTruthy();
        expect(result.url).toMatch(/^https?:\/\//);
      });
    }
  );
});

describe('Integration: error handling with real URLs', () => {
  it('should throw on non-existent domain', async () => {
    await expect(
      scrape('https://this-domain-definitely-does-not-exist-12345.com', {
        timeout: 5000,
        maxRetries: 0,
      })
    ).rejects.toThrow();
  });

  it('should throw on 404 page', async () => {
    await expect(
      scrape('https://httpstat.us/404', {
        timeout: 10000,
        maxRetries: 0,
      })
    ).rejects.toThrow();
  });
});
