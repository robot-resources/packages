import { describe, it, expect } from 'vitest';
import { convertToMarkdown, estimateTokens } from '../convert.js';
import type { ExtractResult } from '../types.js';

describe('convertToMarkdown', () => {
  it('converts simple HTML to markdown', async () => {
    const input: ExtractResult = {
      content: '<h1>Title</h1><p>Hello world</p>',
      title: 'Test',
    };

    const result = await convertToMarkdown(input);

    expect(result.markdown).toContain('# Title');
    expect(result.markdown).toContain('Hello world');
    expect(result.tokenCount).toBeGreaterThan(0);
  });

  it('handles empty content', async () => {
    const input: ExtractResult = {
      content: '',
      title: 'Empty',
    };

    const result = await convertToMarkdown(input);

    expect(result.markdown).toBe('');
    expect(result.tokenCount).toBe(0);
  });

  it('preserves code blocks with language', async () => {
    const input: ExtractResult = {
      content: '<pre><code class="language-typescript">const x = 1;</code></pre>',
      title: 'Code',
    };

    const result = await convertToMarkdown(input);

    expect(result.markdown).toContain('```typescript');
    expect(result.markdown).toContain('const x = 1;');
  });

  it('handles lists correctly', async () => {
    const input: ExtractResult = {
      content: '<ul><li>Item 1</li><li>Item 2</li></ul>',
      title: 'List',
    };

    const result = await convertToMarkdown(input);

    expect(result.markdown).toContain('Item 1');
    expect(result.markdown).toContain('Item 2');
    expect(result.markdown).toContain('-');
  });

  it('handles links', async () => {
    const input: ExtractResult = {
      content: '<a href="https://example.com">Click here</a>',
      title: 'Link',
    };

    const result = await convertToMarkdown(input);

    expect(result.markdown).toContain('[Click here](https://example.com)');
  });
});

describe('estimateTokens', () => {
  it('estimates tokens for simple text', () => {
    const text = 'Hello world';
    const tokens = estimateTokens(text);

    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(10);
  });

  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('accounts for code blocks', () => {
    const withCode = '```typescript\nconst x = 1;\n```';
    const withoutCode = 'const x = 1;';

    const tokensWithCode = estimateTokens(withCode);
    const tokensWithoutCode = estimateTokens(withoutCode);

    expect(tokensWithCode).toBeGreaterThan(tokensWithoutCode);
  });

  // ============================================
  // Accuracy tests (TKT-SCRAPER-064d)
  // Reference: cl100k_base (GPT-4) via tiktoken 0.12.0
  // Requirement: within 15% of actual token counts
  // ============================================

  function expectWithinPercent(estimate: number, actual: number, percent: number) {
    const error = Math.abs(estimate - actual) / actual;
    expect(error).toBeLessThanOrEqual(
      percent / 100,
    );
  }

  it('estimates English prose within 15% (simple sentence)', () => {
    // cl100k_base: 10 tokens
    const text = 'The quick brown fox jumps over the lazy dog.';
    expectWithinPercent(estimateTokens(text), 10, 15);
  });

  it('estimates English prose within 15% (punctuation-heavy)', () => {
    // cl100k_base: 10 tokens
    const text = 'Hello, world! How are you doing today?';
    expectWithinPercent(estimateTokens(text), 10, 15);
  });

  it('estimates code blocks within 15%', () => {
    // cl100k_base: 36 tokens
    const text = '```javascript\nfunction fibonacci(n) {\n  if (n <= 1) return n;\n  return fibonacci(n - 1) + fibonacci(n - 2);\n}\n```';
    expectWithinPercent(estimateTokens(text), 36, 15);
  });

  it('estimates URLs within 15%', () => {
    // cl100k_base: 14 tokens
    const text = 'https://www.example.com/path/to/resource?query=value&page=1';
    expectWithinPercent(estimateTokens(text), 14, 15);
  });

  it('estimates markdown with mixed content within 15%', () => {
    // cl100k_base: 36 tokens
    const text = '# Introduction\n\nThis is a **bold** statement with `inline code` and a [link](https://example.com).\n\n- Item one\n- Item two\n- Item three';
    expectWithinPercent(estimateTokens(text), 36, 15);
  });

  it('estimates long mixed content (prose + code + URL) within 15%', () => {
    // cl100k_base: 52 tokens
    const text = 'The `Array.prototype.map()` method creates a new array populated with the results of calling a provided function on every element in the calling array. See https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map for details.';
    expectWithinPercent(estimateTokens(text), 52, 15);
  });
});
