/**
 * Calculator - Derive metrics and USD savings
 */

import type { LLMModel, SavingsEstimate } from './types.js';
import { LLM_PRICING } from './pricing.js';

/**
 * Calculate compression ratio
 */
export function calculateCompressionRatio(
  inputTokens: number,
  outputTokens: number
): number {
  if (inputTokens === 0) return 0;
  return (inputTokens - outputTokens) / inputTokens;
}

/**
 * Calculate tokens saved
 */
export function calculateTokensSaved(
  inputTokens: number,
  outputTokens: number
): number {
  return Math.max(0, inputTokens - outputTokens);
}

/**
 * Calculate estimated USD savings
 */
export function calculateSavings(
  tokensSaved: number,
  model: LLMModel
): SavingsEstimate {
  const pricing = LLM_PRICING[model];
  const usd = (tokensSaved / 1_000_000) * pricing.inputPerMillion;

  return {
    usd: Math.round(usd * 100) / 100, // Round to cents
    model,
    calculation: `${tokensSaved.toLocaleString()} tokens * $${pricing.inputPerMillion}/1M`,
  };
}

/**
 * Calculate average processing time
 */
export function calculateAverageTime(
  times: number[]
): number | null {
  if (times.length === 0) return null;
  const sum = times.reduce((a, b) => a + b, 0);
  return Math.round(sum / times.length);
}
