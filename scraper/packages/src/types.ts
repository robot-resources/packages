/**
 * Types for tracking-local
 */

/**
 * Supported LLM models for pricing calculation
 */
export type LLMModel =
  | 'gpt-4o'
  | 'gpt-4o-mini'
  | 'claude-3-5-sonnet'
  | 'claude-3-5-haiku'
  | 'gemini-2.0-flash';

/**
 * Options for creating a tracker
 */
export interface TrackerOptions {
  /** LLM model for pricing calculation (default: gpt-4o-mini) */
  model?: LLMModel;
}

/**
 * A single compression event to record
 */
export interface CompressionEvent {
  /** Token count before compression */
  inputTokens: number;
  /** Token count after compression */
  outputTokens: number;
  /** Processing time in milliseconds */
  processingTimeMs?: number;
}

/**
 * Savings calculation details
 */
export interface SavingsEstimate {
  /** Estimated USD saved */
  usd: number;
  /** Model used for calculation */
  model: string;
  /** Calculation breakdown */
  calculation: string;
}

/**
 * Full tracking report
 */
export interface TrackingReport {
  /** Number of URLs processed */
  totalUrls: number;
  /** Total input tokens before compression */
  totalInputTokens: number;
  /** Total output tokens after compression */
  totalOutputTokens: number;
  /** Total tokens saved */
  totalTokensSaved: number;
  /** Compression ratio (0-1) */
  compressionRatio: number;
  /** Average processing time in ms (null if not tracked) */
  averageProcessingTimeMs: number | null;
  /** Estimated savings */
  estimatedSavings: SavingsEstimate;
}

/**
 * Options for marketing message generation
 */
export interface MarketingMessageOptions {
  /** Include emoji in message */
  emoji?: boolean;
  /** Include brand mention */
  includeBrand?: boolean;
}

/**
 * Tracker interface
 */
export interface Tracker {
  /** Record a compression event */
  record(event: CompressionEvent): void;
  /** Get full tracking report */
  getReport(): TrackingReport;
  /** Get marketing message for user */
  getMarketingMessage(options?: MarketingMessageOptions): string;
  /** Reset tracker state */
  reset(): void;
}
