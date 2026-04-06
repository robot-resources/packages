/**
 * Type-level tests for FetchMode, CrawlOptions, CrawlResult
 * TKT-SCRAPER-072: Add FetchMode type + mode option
 *
 * These tests verify type assignments compile correctly and
 * backward compatibility is maintained.
 */

import { describe, it, expect } from 'vitest';
import type {
  FetchMode,
  ScrapeOptions,
  ScrapeResult,
  CrawlOptions,
  CrawlResult,
  CrawlPageResult,
  CrawlError,
} from '../types.js';

describe('FetchMode type', () => {
  it('accepts all valid mode values', () => {
    const fast: FetchMode = 'fast';
    const stealth: FetchMode = 'stealth';
    const render: FetchMode = 'render';
    const auto: FetchMode = 'auto';
    expect(fast).toBe('fast');
    expect(stealth).toBe('stealth');
    expect(render).toBe('render');
    expect(auto).toBe('auto');
  });
});

describe('ScrapeOptions backward compatibility', () => {
  it('accepts empty options (all fields optional)', () => {
    const opts: ScrapeOptions = {};
    expect(opts).toEqual({});
  });

  it('accepts existing fields without mode', () => {
    const opts: ScrapeOptions = {
      timeout: 5000,
      maxRetries: 2,
      userAgent: 'test',
      respectRobots: true,
    };
    expect(opts.timeout).toBe(5000);
    expect(opts.maxRetries).toBe(2);
  });

  it('accepts mode as optional field', () => {
    const opts: ScrapeOptions = { mode: 'auto' };
    expect(opts.mode).toBe('auto');
  });

  it('accepts all mode values in ScrapeOptions', () => {
    const opts1: ScrapeOptions = { mode: 'fast' };
    const opts2: ScrapeOptions = { mode: 'stealth' };
    const opts3: ScrapeOptions = { mode: 'render' };
    const opts4: ScrapeOptions = { mode: 'auto' };
    expect(opts1.mode).toBe('fast');
    expect(opts2.mode).toBe('stealth');
    expect(opts3.mode).toBe('render');
    expect(opts4.mode).toBe('auto');
  });
});

describe('CrawlOptions type', () => {
  it('requires only url field', () => {
    const opts: CrawlOptions = { url: 'https://example.com' };
    expect(opts.url).toBe('https://example.com');
  });

  it('accepts all optional fields', () => {
    const opts: CrawlOptions = {
      url: 'https://example.com',
      depth: 2,
      limit: 50,
      mode: 'auto',
      include: ['/docs/*'],
      exclude: ['/admin/*'],
      timeout: 10000,
      concurrency: 3,
      respectRobots: true,
    };
    expect(opts.depth).toBe(2);
    expect(opts.limit).toBe(50);
    expect(opts.mode).toBe('auto');
    expect(opts.include).toEqual(['/docs/*']);
    expect(opts.exclude).toEqual(['/admin/*']);
    expect(opts.timeout).toBe(10000);
    expect(opts.concurrency).toBe(3);
    expect(opts.respectRobots).toBe(true);
  });

  it('depth = 0 is valid (crawl only starting URL)', () => {
    const opts: CrawlOptions = { url: 'https://example.com', depth: 0 };
    expect(opts.depth).toBe(0);
  });
});

describe('CrawlResult type', () => {
  it('has all required fields', () => {
    const result: CrawlResult = {
      pages: [],
      totalDiscovered: 0,
      totalCrawled: 0,
      totalSkipped: 0,
      errors: [],
      duration: 100,
    };
    expect(result.pages).toEqual([]);
    expect(result.totalDiscovered).toBe(0);
    expect(result.totalCrawled).toBe(0);
    expect(result.totalSkipped).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.duration).toBe(100);
  });
});

describe('CrawlPageResult type', () => {
  it('extends ScrapeResult with depth field', () => {
    const page: CrawlPageResult = {
      markdown: '# Test',
      tokenCount: 10,
      url: 'https://example.com',
      depth: 1,
    };
    expect(page.markdown).toBe('# Test');
    expect(page.tokenCount).toBe(10);
    expect(page.url).toBe('https://example.com');
    expect(page.depth).toBe(1);
  });

  it('includes optional ScrapeResult fields', () => {
    const page: CrawlPageResult = {
      markdown: '# Test',
      tokenCount: 10,
      url: 'https://example.com',
      depth: 0,
      title: 'Test Page',
      author: 'Author',
      siteName: 'Example',
      publishedAt: '2026-01-01',
    };
    expect(page.title).toBe('Test Page');
    expect(page.author).toBe('Author');
    expect(page.siteName).toBe('Example');
  });
});

describe('CrawlError type', () => {
  it('has url, error, and depth fields', () => {
    const err: CrawlError = {
      url: 'https://example.com/broken',
      error: 'HTTP 404',
      depth: 2,
    };
    expect(err.url).toBe('https://example.com/broken');
    expect(err.error).toBe('HTTP 404');
    expect(err.depth).toBe(2);
  });
});
