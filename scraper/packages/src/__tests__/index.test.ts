import { describe, it, expect } from 'vitest';
import {
  createTracker,
  LLM_PRICING,
  DEFAULT_MODEL,
  calculateCompressionRatio,
  calculateTokensSaved,
  calculateSavings,
  generateMarketingMessage,
  generateShortMessage,
} from '../index.js';

describe('tracking-local exports', () => {
  it('exports createTracker', () => {
    expect(typeof createTracker).toBe('function');
  });

  it('exports LLM_PRICING', () => {
    expect(LLM_PRICING).toBeDefined();
    expect(LLM_PRICING['gpt-4o-mini']).toBeDefined();
  });

  it('exports DEFAULT_MODEL', () => {
    expect(DEFAULT_MODEL).toBe('gpt-4o-mini');
  });

  it('exports calculator functions', () => {
    expect(typeof calculateCompressionRatio).toBe('function');
    expect(typeof calculateTokensSaved).toBe('function');
    expect(typeof calculateSavings).toBe('function');
  });

  it('exports reporter functions', () => {
    expect(typeof generateMarketingMessage).toBe('function');
    expect(typeof generateShortMessage).toBe('function');
  });
});

describe('createTracker', () => {
  it('creates working tracker', () => {
    const tracker = createTracker();
    expect(tracker).toBeDefined();
    expect(typeof tracker.record).toBe('function');
    expect(typeof tracker.getReport).toBe('function');
    expect(typeof tracker.getMarketingMessage).toBe('function');
    expect(typeof tracker.reset).toBe('function');
  });
});

describe('integration test', () => {
  it('full workflow works', () => {
    const tracker = createTracker({ model: 'gpt-4o-mini' });

    // Simulate agent compressing 3 pages
    tracker.record({ inputTokens: 15000, outputTokens: 1200, processingTimeMs: 800 });
    tracker.record({ inputTokens: 12000, outputTokens: 900, processingTimeMs: 650 });
    tracker.record({ inputTokens: 18000, outputTokens: 1500, processingTimeMs: 920 });

    const report = tracker.getReport();

    expect(report.totalUrls).toBe(3);
    expect(report.totalInputTokens).toBe(45000);
    expect(report.totalOutputTokens).toBe(3600);
    expect(report.totalTokensSaved).toBe(41400);
    expect(report.compressionRatio).toBeCloseTo(0.92, 2);
    expect(report.averageProcessingTimeMs).toBe(790);
    expect(report.estimatedSavings.usd).toBeGreaterThan(0);

    const message = tracker.getMarketingMessage({ emoji: true });
    expect(message).toContain('💰');
    expect(message).toContain('3 pages');
    expect(message).toContain('Scraper');
  });
});
