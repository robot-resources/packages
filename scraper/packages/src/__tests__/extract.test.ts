import { describe, it, expect } from 'vitest';
import { extractContent, ExtractionError } from '../extract.js';
import type { FetchResult } from '../types.js';

describe('extractContent', () => {
  it('extracts content from valid HTML', async () => {
    const input: FetchResult = {
      html: `
        <!DOCTYPE html>
        <html>
        <head><title>Test Page</title></head>
        <body>
          <article>
            <h1>Main Article</h1>
            <p>This is the main content of the article that should be extracted by readability. It needs to be long enough to pass the threshold.</p>
            <p>Here is another paragraph with more content to ensure extraction works properly.</p>
          </article>
        </body>
        </html>
      `,
      url: 'https://example.com',
      statusCode: 200,
      headers: {},
    };

    const result = await extractContent(input);

    expect(result.content).toBeTruthy();
    expect(result.title).toBe('Test Page');
  });

  it('throws on empty HTML', async () => {
    const input: FetchResult = {
      html: '',
      url: 'https://example.com',
      statusCode: 200,
      headers: {},
    };

    await expect(extractContent(input)).rejects.toThrow(ExtractionError);
  });

  it('throws when no content extractable', async () => {
    const input: FetchResult = {
      html: '<html><body><script>alert(1)</script></body></html>',
      url: 'https://example.com',
      statusCode: 200,
      headers: {},
    };

    await expect(extractContent(input)).rejects.toThrow(ExtractionError);
  });

  it('extracts og:title as fallback', async () => {
    const input: FetchResult = {
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta property="og:title" content="OG Title">
        </head>
        <body>
          <article>
            <p>This is the main content of the article that should be extracted by readability. It needs to be long enough to pass the threshold.</p>
            <p>Here is another paragraph with more content to ensure extraction works properly.</p>
          </article>
        </body>
        </html>
      `,
      url: 'https://example.com',
      statusCode: 200,
      headers: {},
    };

    const result = await extractContent(input);

    expect(result.title).toBe('OG Title');
  });

  it('extracts site name from meta', async () => {
    const input: FetchResult = {
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Test</title>
          <meta property="og:site_name" content="Example Site">
        </head>
        <body>
          <article>
            <p>This is the main content of the article that should be extracted by readability. It needs to be long enough to pass the threshold.</p>
            <p>Here is another paragraph with more content to ensure extraction works properly.</p>
          </article>
        </body>
        </html>
      `,
      url: 'https://example.com',
      statusCode: 200,
      headers: {},
    };

    const result = await extractContent(input);

    expect(result.siteName).toBe('Example Site');
  });
});
