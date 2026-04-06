import { describe, it, expect } from 'vitest';
import { generateMarketingMessage, generateShortMessage } from '../reporter.js';
import type { TrackingReport } from '../types.js';

const mockReport: TrackingReport = {
  totalUrls: 15,
  totalInputTokens: 450000,
  totalOutputTokens: 32000,
  totalTokensSaved: 418000,
  compressionRatio: 0.929,
  averageProcessingTimeMs: 1150,
  estimatedSavings: {
    usd: 0.42,
    model: 'gpt-4o-mini',
    calculation: '418,000 tokens * $0.15/1M',
  },
};

describe('generateMarketingMessage', () => {
  it('generates default message', () => {
    const message = generateMarketingMessage(mockReport);
    expect(message).toContain('15 pages');
    expect(message).toContain('93%');
    expect(message).toContain('$0.42');
    expect(message).toContain('Scraper');
  });

  it('generates message with emoji', () => {
    const message = generateMarketingMessage(mockReport, { emoji: true });
    expect(message).toContain('💰');
    expect(message).toContain('Saved');
  });

  it('generates message without brand', () => {
    const message = generateMarketingMessage(mockReport, { includeBrand: false });
    expect(message).not.toContain('Scraper');
  });

  it('handles single page', () => {
    const singlePageReport = { ...mockReport, totalUrls: 1 };
    const message = generateMarketingMessage(singlePageReport);
    expect(message).toContain('1 page');
  });

  it('handles zero pages', () => {
    const emptyReport = { ...mockReport, totalUrls: 0 };
    const message = generateMarketingMessage(emptyReport);
    expect(message).toContain('No pages compressed');
  });

  it('handles emoji with zero pages', () => {
    const emptyReport = { ...mockReport, totalUrls: 0 };
    const message = generateMarketingMessage(emptyReport, { emoji: true });
    expect(message).toContain('📊');
  });
});

describe('generateShortMessage', () => {
  it('generates short message', () => {
    const message = generateShortMessage(mockReport);
    expect(message).toContain('93%');
    expect(message).toContain('$0.42');
  });

  it('handles zero data', () => {
    const emptyReport = { ...mockReport, totalUrls: 0 };
    expect(generateShortMessage(emptyReport)).toBe('No data');
  });
});

// ============================================
// Error-path tests (A5-1 audit finding)
// ============================================

describe('generateMarketingMessage — edge cases', () => {
  it('handles very small savings (<$0.01)', () => {
    const report: TrackingReport = {
      ...mockReport,
      totalUrls: 1,
      estimatedSavings: { usd: 0.001, model: 'gpt-4o-mini', calculation: '' },
    };
    const message = generateMarketingMessage(report);
    expect(message).toContain('<$0.01');
  });

  it('handles zero compression ratio', () => {
    const report: TrackingReport = {
      ...mockReport,
      compressionRatio: 0,
      estimatedSavings: { usd: 0, model: 'gpt-4o-mini', calculation: '' },
    };
    const message = generateMarketingMessage(report);
    expect(message).toContain('0%');
  });

  it('handles negative compression ratio (expansion)', () => {
    const report: TrackingReport = {
      ...mockReport,
      compressionRatio: -0.5,
      estimatedSavings: { usd: 0, model: 'gpt-4o-mini', calculation: '' },
    };
    const message = generateMarketingMessage(report);
    // Math.round(-0.5 * 100) = -50, so "-50%"
    expect(message).toContain('-50%');
  });

  it('handles emoji + no brand combination', () => {
    const message = generateMarketingMessage(mockReport, { emoji: true, includeBrand: false });
    expect(message).toContain('💰');
    expect(message).not.toContain('Scraper');
  });
});

describe('generateShortMessage — edge cases', () => {
  it('handles very small savings in short format', () => {
    const report: TrackingReport = {
      ...mockReport,
      estimatedSavings: { usd: 0.005, model: 'gpt-4o-mini', calculation: '' },
    };
    const message = generateShortMessage(report);
    expect(message).toContain('<$0.01');
  });

  it('handles 100% compression ratio', () => {
    const report: TrackingReport = {
      ...mockReport,
      compressionRatio: 1.0,
    };
    const message = generateShortMessage(report);
    expect(message).toContain('100%');
  });
});
