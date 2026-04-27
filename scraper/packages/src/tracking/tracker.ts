/**
 * Tracker - Event accumulator
 */

import type {
  Tracker,
  TrackerOptions,
  CompressionEvent,
  TrackingReport,
  MarketingMessageOptions,
  LLMModel,
} from './types.js';
import { DEFAULT_MODEL } from './pricing.js';
import {
  calculateCompressionRatio,
  calculateTokensSaved,
  calculateSavings,
  calculateAverageTime,
} from './calculator.js';
import { generateMarketingMessage } from './reporter.js';

/**
 * Internal state for tracker
 */
interface TrackerState {
  model: LLMModel;
  events: CompressionEvent[];
  totalInputTokens: number;
  totalOutputTokens: number;
  processingTimes: number[];
}

/**
 * Create initial state
 */
function createInitialState(model: LLMModel): TrackerState {
  return {
    model,
    events: [],
    totalInputTokens: 0,
    totalOutputTokens: 0,
    processingTimes: [],
  };
}

/**
 * Create a new tracker instance
 */
export function createTrackerInstance(options: TrackerOptions = {}): Tracker {
  const model = options.model || DEFAULT_MODEL;
  let state = createInitialState(model);

  const tracker: Tracker = {
    record(event: CompressionEvent): void {
      state.events.push(event);
      state.totalInputTokens += event.inputTokens;
      state.totalOutputTokens += event.outputTokens;

      if (event.processingTimeMs !== undefined) {
        state.processingTimes.push(event.processingTimeMs);
      }
    },

    getReport(): TrackingReport {
      const totalTokensSaved = calculateTokensSaved(
        state.totalInputTokens,
        state.totalOutputTokens
      );

      const compressionRatio = calculateCompressionRatio(
        state.totalInputTokens,
        state.totalOutputTokens
      );

      const estimatedSavings = calculateSavings(totalTokensSaved, state.model);

      const averageProcessingTimeMs = calculateAverageTime(state.processingTimes);

      return {
        totalUrls: state.events.length,
        totalInputTokens: state.totalInputTokens,
        totalOutputTokens: state.totalOutputTokens,
        totalTokensSaved,
        compressionRatio,
        averageProcessingTimeMs,
        estimatedSavings,
      };
    },

    getMarketingMessage(options?: MarketingMessageOptions): string {
      const report = tracker.getReport();
      return generateMarketingMessage(report, options);
    },

    reset(): void {
      state = createInitialState(state.model);
    },
  };

  return tracker;
}
