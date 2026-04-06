import { describe, it, expect } from 'vitest';
import {
  calculateCompressionRatio,
  calculateTokensSaved,
  calculateSavings,
  calculateAverageTime,
} from '../calculator.js';

describe('calculateCompressionRatio', () => {
  it('calculates correct ratio', () => {
    const ratio = calculateCompressionRatio(10000, 3000);
    expect(ratio).toBe(0.7);
  });

  it('returns 0 for zero input', () => {
    expect(calculateCompressionRatio(0, 0)).toBe(0);
  });

  it('handles no compression', () => {
    expect(calculateCompressionRatio(1000, 1000)).toBe(0);
  });

  it('handles full compression', () => {
    expect(calculateCompressionRatio(1000, 0)).toBe(1);
  });
});

describe('calculateTokensSaved', () => {
  it('calculates tokens saved', () => {
    expect(calculateTokensSaved(10000, 3000)).toBe(7000);
  });

  it('returns 0 if output >= input', () => {
    expect(calculateTokensSaved(1000, 1000)).toBe(0);
    expect(calculateTokensSaved(1000, 1500)).toBe(0);
  });
});

describe('calculateSavings', () => {
  it('calculates USD savings for gpt-4o-mini', () => {
    const savings = calculateSavings(1000000, 'gpt-4o-mini');
    expect(savings.usd).toBe(0.15);
    expect(savings.model).toBe('gpt-4o-mini');
  });

  it('calculates USD savings for gpt-4o', () => {
    const savings = calculateSavings(1000000, 'gpt-4o');
    expect(savings.usd).toBe(2.5);
  });

  it('calculates USD savings for claude-3-5-sonnet', () => {
    const savings = calculateSavings(1000000, 'claude-3-5-sonnet');
    expect(savings.usd).toBe(3);
  });

  it('calculates USD savings for claude-3-5-haiku', () => {
    const savings = calculateSavings(1000000, 'claude-3-5-haiku');
    expect(savings.usd).toBe(0.25);
  });

  it('calculates USD savings for gemini-2.0-flash', () => {
    const savings = calculateSavings(1000000, 'gemini-2.0-flash');
    expect(savings.usd).toBe(0.1);
  });

  it('rounds to cents', () => {
    const savings = calculateSavings(123456, 'gpt-4o-mini');
    expect(savings.usd).toBe(0.02); // 0.0185... rounds to 0.02
  });

  it('includes calculation string', () => {
    const savings = calculateSavings(500000, 'gpt-4o-mini');
    expect(savings.calculation).toContain('500,000 tokens');
    expect(savings.calculation).toContain('$0.15/1M');
  });
});

describe('calculateAverageTime', () => {
  it('calculates average', () => {
    expect(calculateAverageTime([100, 200, 300])).toBe(200);
  });

  it('returns null for empty array', () => {
    expect(calculateAverageTime([])).toBe(null);
  });

  it('rounds to integer', () => {
    expect(calculateAverageTime([100, 101])).toBe(101); // 100.5 rounds to 101
  });
});

// ============================================
// Error-path tests (A5-1 audit finding)
// ============================================

describe('calculateCompressionRatio — edge cases', () => {
  it('handles negative inputTokens', () => {
    const ratio = calculateCompressionRatio(-1000, 500);
    expect(typeof ratio).toBe('number');
    expect(Number.isFinite(ratio)).toBe(true);
  });

  it('handles negative outputTokens', () => {
    const ratio = calculateCompressionRatio(1000, -500);
    expect(typeof ratio).toBe('number');
  });

  it('handles both negative', () => {
    const ratio = calculateCompressionRatio(-1000, -500);
    expect(typeof ratio).toBe('number');
  });

  it('handles NaN inputs', () => {
    const ratio = calculateCompressionRatio(NaN, 1000);
    expect(Number.isNaN(ratio)).toBe(true);
  });

  it('handles Infinity inputs', () => {
    const ratio = calculateCompressionRatio(Infinity, 1000);
    expect(Number.isFinite(ratio)).toBe(false);
  });

  it('handles output greater than input', () => {
    // Expansion: 1000 -> 2000 = -100% ratio (negative)
    const ratio = calculateCompressionRatio(1000, 2000);
    expect(ratio).toBe(-1);
  });
});

describe('calculateTokensSaved — edge cases', () => {
  it('clamps to 0 when output exceeds input (never negative)', () => {
    expect(calculateTokensSaved(100, 500)).toBe(0);
  });

  it('handles negative inputs gracefully', () => {
    // Math.max(0, -1000 - 500) = 0
    expect(calculateTokensSaved(-1000, 500)).toBe(0);
  });

  it('handles NaN inputs', () => {
    const result = calculateTokensSaved(NaN, 1000);
    // NaN - 1000 = NaN, Math.max(0, NaN) = NaN (per JS spec)
    expect(Number.isNaN(result) || result === 0).toBe(true);
  });

  it('handles very large numbers', () => {
    const result = calculateTokensSaved(Number.MAX_SAFE_INTEGER, 0);
    expect(result).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('calculateSavings — edge cases', () => {
  it('handles zero tokens saved', () => {
    const savings = calculateSavings(0, 'gpt-4o-mini');
    expect(savings.usd).toBe(0);
  });

  it('returns 0 USD for very small savings', () => {
    // 1 token * $0.15/1M = 0.00000015 → rounds to 0
    const savings = calculateSavings(1, 'gpt-4o-mini');
    expect(savings.usd).toBe(0);
  });

  it('handles very large token counts without overflow', () => {
    const savings = calculateSavings(1_000_000_000, 'gpt-4o');
    expect(Number.isFinite(savings.usd)).toBe(true);
    expect(savings.usd).toBeGreaterThan(0);
  });
});

describe('calculateAverageTime — edge cases', () => {
  it('handles single element', () => {
    expect(calculateAverageTime([42])).toBe(42);
  });

  it('handles zero values', () => {
    expect(calculateAverageTime([0, 0, 0])).toBe(0);
  });

  it('handles very large values', () => {
    const result = calculateAverageTime([Number.MAX_SAFE_INTEGER]);
    expect(result).toBe(Number.MAX_SAFE_INTEGER);
  });
});
