import { describe, it, expect } from 'vitest';
import { LLM_PRICING, DEFAULT_MODEL } from '../pricing.js';
import type { ModelPricing } from '../pricing.js';
import type { LLMModel } from '../types.js';

/**
 * Expected models — derived from the LLMModel type definition.
 * If a model is added or removed from the type, this list must be updated.
 */
const EXPECTED_MODELS: LLMModel[] = [
  'gpt-4o',
  'gpt-4o-mini',
  'claude-3-5-sonnet',
  'claude-3-5-haiku',
  'gemini-2.0-flash',
];

describe('LLM_PRICING', () => {
  it('is not empty', () => {
    expect(Object.keys(LLM_PRICING).length).toBeGreaterThan(0);
  });

  it('contains all expected models', () => {
    for (const model of EXPECTED_MODELS) {
      expect(LLM_PRICING).toHaveProperty(model);
    }
  });

  it('has no unexpected models beyond the expected set', () => {
    const actualModels = Object.keys(LLM_PRICING).sort();
    const expected = [...EXPECTED_MODELS].sort();
    expect(actualModels).toEqual(expected);
  });

  describe('pricing values', () => {
    for (const model of EXPECTED_MODELS) {
      describe(model, () => {
        it('has positive inputPerMillion', () => {
          expect(LLM_PRICING[model].inputPerMillion).toBeGreaterThan(0);
        });

        it('has positive outputPerMillion', () => {
          expect(LLM_PRICING[model].outputPerMillion).toBeGreaterThan(0);
        });

        it('has outputPerMillion >= inputPerMillion', () => {
          const pricing = LLM_PRICING[model];
          expect(pricing.outputPerMillion).toBeGreaterThanOrEqual(
            pricing.inputPerMillion,
          );
        });
      });
    }
  });

  it('has correct shape for each entry (inputPerMillion and outputPerMillion only)', () => {
    for (const model of EXPECTED_MODELS) {
      const pricing = LLM_PRICING[model];
      const keys = Object.keys(pricing).sort();
      expect(keys).toEqual(['inputPerMillion', 'outputPerMillion']);
    }
  });

  it('all values are finite numbers (not NaN or Infinity)', () => {
    for (const model of EXPECTED_MODELS) {
      const pricing = LLM_PRICING[model];
      expect(Number.isFinite(pricing.inputPerMillion)).toBe(true);
      expect(Number.isFinite(pricing.outputPerMillion)).toBe(true);
    }
  });
});

describe('DEFAULT_MODEL', () => {
  it('is a valid key in LLM_PRICING', () => {
    expect(LLM_PRICING).toHaveProperty(DEFAULT_MODEL);
  });

  it('is gpt-4o-mini', () => {
    expect(DEFAULT_MODEL).toBe('gpt-4o-mini');
  });
});

describe('ModelPricing type compliance', () => {
  it('each entry satisfies ModelPricing interface', () => {
    for (const model of EXPECTED_MODELS) {
      const pricing: ModelPricing = LLM_PRICING[model];
      expect(typeof pricing.inputPerMillion).toBe('number');
      expect(typeof pricing.outputPerMillion).toBe('number');
    }
  });
});
