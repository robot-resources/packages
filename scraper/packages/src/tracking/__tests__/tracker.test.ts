import { describe, it, expect } from 'vitest';
import { createTrackerInstance } from '../tracker.js';

describe('createTrackerInstance', () => {
  it('creates tracker with default model', () => {
    const tracker = createTrackerInstance();
    const report = tracker.getReport();
    expect(report.estimatedSavings.model).toBe('gpt-4o-mini');
  });

  it('creates tracker with custom model', () => {
    const tracker = createTrackerInstance({ model: 'claude-3-5-haiku' });
    const report = tracker.getReport();
    expect(report.estimatedSavings.model).toBe('claude-3-5-haiku');
  });
});

describe('tracker.record', () => {
  it('records single event', () => {
    const tracker = createTrackerInstance();
    tracker.record({ inputTokens: 10000, outputTokens: 3000 });

    const report = tracker.getReport();
    expect(report.totalUrls).toBe(1);
    expect(report.totalInputTokens).toBe(10000);
    expect(report.totalOutputTokens).toBe(3000);
  });

  it('accumulates multiple events', () => {
    const tracker = createTrackerInstance();
    tracker.record({ inputTokens: 10000, outputTokens: 3000 });
    tracker.record({ inputTokens: 20000, outputTokens: 5000 });
    tracker.record({ inputTokens: 15000, outputTokens: 4000 });

    const report = tracker.getReport();
    expect(report.totalUrls).toBe(3);
    expect(report.totalInputTokens).toBe(45000);
    expect(report.totalOutputTokens).toBe(12000);
  });

  it('tracks processing time', () => {
    const tracker = createTrackerInstance();
    tracker.record({ inputTokens: 10000, outputTokens: 3000, processingTimeMs: 100 });
    tracker.record({ inputTokens: 10000, outputTokens: 3000, processingTimeMs: 200 });

    const report = tracker.getReport();
    expect(report.averageProcessingTimeMs).toBe(150);
  });

  it('handles missing processing time', () => {
    const tracker = createTrackerInstance();
    tracker.record({ inputTokens: 10000, outputTokens: 3000 });

    const report = tracker.getReport();
    expect(report.averageProcessingTimeMs).toBe(null);
  });
});

describe('tracker.getReport', () => {
  it('calculates compression ratio', () => {
    const tracker = createTrackerInstance();
    tracker.record({ inputTokens: 10000, outputTokens: 3000 });

    const report = tracker.getReport();
    expect(report.compressionRatio).toBe(0.7);
  });

  it('calculates tokens saved', () => {
    const tracker = createTrackerInstance();
    tracker.record({ inputTokens: 10000, outputTokens: 3000 });

    const report = tracker.getReport();
    expect(report.totalTokensSaved).toBe(7000);
  });

  it('calculates USD savings', () => {
    const tracker = createTrackerInstance({ model: 'gpt-4o-mini' });
    tracker.record({ inputTokens: 1000000, outputTokens: 300000 });

    const report = tracker.getReport();
    expect(report.estimatedSavings.usd).toBe(0.11); // 700000 * 0.15 / 1M = 0.105 -> 0.11
  });

  it('returns empty report for no events', () => {
    const tracker = createTrackerInstance();
    const report = tracker.getReport();

    expect(report.totalUrls).toBe(0);
    expect(report.totalInputTokens).toBe(0);
    expect(report.totalOutputTokens).toBe(0);
    expect(report.compressionRatio).toBe(0);
  });
});

describe('tracker.getMarketingMessage', () => {
  it('returns marketing message', () => {
    const tracker = createTrackerInstance();
    tracker.record({ inputTokens: 45000, outputTokens: 3200 });

    const message = tracker.getMarketingMessage();
    expect(message).toContain('1 page');
    expect(message).toContain('Scraper');
  });

  it('supports emoji option', () => {
    const tracker = createTrackerInstance();
    tracker.record({ inputTokens: 45000, outputTokens: 3200 });

    const message = tracker.getMarketingMessage({ emoji: true });
    expect(message).toContain('💰');
  });
});

describe('tracker.reset', () => {
  it('clears all state', () => {
    const tracker = createTrackerInstance();
    tracker.record({ inputTokens: 10000, outputTokens: 3000 });
    tracker.record({ inputTokens: 20000, outputTokens: 5000 });

    tracker.reset();

    const report = tracker.getReport();
    expect(report.totalUrls).toBe(0);
    expect(report.totalInputTokens).toBe(0);
    expect(report.totalOutputTokens).toBe(0);
  });

  it('preserves model after reset', () => {
    const tracker = createTrackerInstance({ model: 'claude-3-5-sonnet' });
    tracker.record({ inputTokens: 10000, outputTokens: 3000 });
    tracker.reset();

    const report = tracker.getReport();
    expect(report.estimatedSavings.model).toBe('claude-3-5-sonnet');
  });
});

// ============================================
// Error-path tests (A5-1 audit finding)
// ============================================

describe('tracker.record — edge cases', () => {
  it('handles zero token events', () => {
    const tracker = createTrackerInstance();
    tracker.record({ inputTokens: 0, outputTokens: 0 });

    const report = tracker.getReport();
    expect(report.totalUrls).toBe(1);
    expect(report.totalInputTokens).toBe(0);
    expect(report.compressionRatio).toBe(0);
  });

  it('handles output > input (expansion)', () => {
    const tracker = createTrackerInstance();
    tracker.record({ inputTokens: 100, outputTokens: 500 });

    const report = tracker.getReport();
    expect(report.totalTokensSaved).toBe(0); // clamped by calculateTokensSaved
    expect(report.compressionRatio).toBeLessThan(0); // negative ratio
  });

  it('handles negative token values without crashing', () => {
    const tracker = createTrackerInstance();
    tracker.record({ inputTokens: -100, outputTokens: -50 });

    const report = tracker.getReport();
    expect(report.totalUrls).toBe(1);
    // Should not throw — produces nonsensical but non-crashing results
    expect(typeof report.totalInputTokens).toBe('number');
  });

  it('handles very large token values', () => {
    const tracker = createTrackerInstance();
    tracker.record({ inputTokens: 1_000_000_000, outputTokens: 100_000_000 });

    const report = tracker.getReport();
    expect(report.totalTokensSaved).toBe(900_000_000);
    expect(Number.isFinite(report.estimatedSavings.usd)).toBe(true);
  });

  it('handles zero processing time', () => {
    const tracker = createTrackerInstance();
    tracker.record({ inputTokens: 1000, outputTokens: 100, processingTimeMs: 0 });

    const report = tracker.getReport();
    expect(report.averageProcessingTimeMs).toBe(0);
  });
});

describe('tracker.getReport — empty state', () => {
  it('returns safe defaults when no events recorded', () => {
    const tracker = createTrackerInstance();
    const report = tracker.getReport();

    expect(report.totalUrls).toBe(0);
    expect(report.totalInputTokens).toBe(0);
    expect(report.totalOutputTokens).toBe(0);
    expect(report.totalTokensSaved).toBe(0);
    expect(report.compressionRatio).toBe(0);
    expect(report.averageProcessingTimeMs).toBeNull();
    expect(report.estimatedSavings.usd).toBe(0);
  });
});
