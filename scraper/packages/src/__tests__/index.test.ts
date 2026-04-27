import { describe, it, expect } from 'vitest';
import {
  scrape,
  fetchUrl,
  extractContent,
  convertToMarkdown,
  estimateTokens,
  FetchError,
  ExtractionError,
} from '../index.js';

describe('scraper exports', () => {
  it('exports scrape function', () => {
    expect(typeof scrape).toBe('function');
  });

  it('exports fetchUrl function', () => {
    expect(typeof fetchUrl).toBe('function');
  });

  it('exports extractContent function', () => {
    expect(typeof extractContent).toBe('function');
  });

  it('exports convertToMarkdown function', () => {
    expect(typeof convertToMarkdown).toBe('function');
  });

  it('exports estimateTokens function', () => {
    expect(typeof estimateTokens).toBe('function');
  });

  it('exports FetchError class', () => {
    expect(typeof FetchError).toBe('function');
    const error = new FetchError('test');
    expect(error).toBeInstanceOf(Error);
  });

  it('exports ExtractionError class', () => {
    expect(typeof ExtractionError).toBe('function');
    const error = new ExtractionError('test', 'CODE');
    expect(error).toBeInstanceOf(Error);
  });
});

describe('scrape function', () => {
  it('throws FetchError on invalid URL', async () => {
    await expect(scrape('not-a-url')).rejects.toThrow(FetchError);
  });

  it('throws FetchError on non-HTTP URL', async () => {
    await expect(scrape('ftp://example.com')).rejects.toThrow(FetchError);
  });

  it('throws FetchError on negative timeout', async () => {
    await expect(scrape('https://example.com', { timeout: -1 })).rejects.toThrow(FetchError);
    await expect(scrape('https://example.com', { timeout: -1 })).rejects.toThrow(/timeout must be a positive number/);
  });

  it('throws FetchError on zero timeout', async () => {
    await expect(scrape('https://example.com', { timeout: 0 })).rejects.toThrow(FetchError);
  });

  it('throws FetchError on NaN timeout', async () => {
    await expect(scrape('https://example.com', { timeout: NaN })).rejects.toThrow(FetchError);
  });
});

describe('token reduction', () => {
  it('demonstrates token reduction concept', async () => {
    // Sample HTML with typical web page bloat
    const bloatedHtml = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Article Title</title>
        <link rel="stylesheet" href="styles.css">
        <script src="analytics.js"></script>
      </head>
      <body>
        <header>
          <nav>Menu items here</nav>
        </header>
        <main>
          <article>
            <h1>The Main Article</h1>
            <p>This is the actual content that matters for AI agents.</p>
            <p>More important content here.</p>
          </article>
        </main>
        <aside>Sidebar content</aside>
        <footer>Copyright 2024</footer>
      </body>
      </html>
    `;

    const expectedMarkdown = `# The Main Article

This is the actual content that matters for AI agents.

More important content here.`;

    const htmlTokens = estimateTokens(bloatedHtml);
    const markdownTokens = estimateTokens(expectedMarkdown);

    // Markdown should be significantly smaller
    const reduction = ((htmlTokens - markdownTokens) / htmlTokens) * 100;

    expect(reduction).toBeGreaterThan(50); // At least 50% reduction
  });
});
