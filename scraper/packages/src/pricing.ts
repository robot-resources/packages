/**
 * LLM Pricing Data
 * Prices in USD per 1 million tokens
 *
 * WARNING: These prices are hardcoded and WILL go stale.
 * Last verified: 2026-03-19
 * TODO: Move to a remote config or database for live updates.
 */

import type { LLMModel } from './types.js';

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

export const LLM_PRICING: Record<LLMModel, ModelPricing> = {
  'gpt-4o': {
    inputPerMillion: 2.5,
    outputPerMillion: 10.0,
  },
  'gpt-4o-mini': {
    inputPerMillion: 0.15,
    outputPerMillion: 0.6,
  },
  'claude-3-5-sonnet': {
    inputPerMillion: 3.0,
    outputPerMillion: 15.0,
  },
  'claude-3-5-haiku': {
    inputPerMillion: 0.25,
    outputPerMillion: 1.25,
  },
  'gemini-2.0-flash': {
    inputPerMillion: 0.1,
    outputPerMillion: 0.4,
  },
};

export const DEFAULT_MODEL: LLMModel = 'gpt-4o-mini';
