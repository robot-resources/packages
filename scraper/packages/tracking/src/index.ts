/**
 * tracking
 * Local usage tracking for AI agents using Scraper
 *
 * @packageDocumentation
 */

// Re-export types
export type {
  Tracker,
  TrackerOptions,
  CompressionEvent,
  TrackingReport,
  SavingsEstimate,
  MarketingMessageOptions,
  LLMModel,
} from './types.js';

// Re-export pricing
export { LLM_PRICING, DEFAULT_MODEL } from './pricing.js';

// Re-export calculator functions for advanced usage
export {
  calculateCompressionRatio,
  calculateTokensSaved,
  calculateSavings,
  calculateAverageTime,
} from './calculator.js';

// Re-export reporter functions
export { generateMarketingMessage, generateShortMessage } from './reporter.js';

// Main export
import type { Tracker, TrackerOptions } from './types.js';
import { createTrackerInstance } from './tracker.js';

/**
 * Create a new tracker to accumulate compression statistics
 *
 * @example
 * ```typescript
 * import { createTracker } from '@robot-resources/tracking-local';
 *
 * const tracker = createTracker({ model: 'gpt-4o-mini' });
 *
 * // Record compression events
 * tracker.record({ inputTokens: 45000, outputTokens: 3200 });
 *
 * // Get report
 * const report = tracker.getReport();
 * console.log(report.estimatedSavings.usd);
 *
 * // Get marketing message
 * console.log(tracker.getMarketingMessage({ emoji: true }));
 * ```
 *
 * @param options - Tracker options
 * @returns Tracker instance
 */
export function createTracker(options?: TrackerOptions): Tracker {
  return createTrackerInstance(options);
}
