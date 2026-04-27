import { describe, it, expect } from 'vitest';
import {
  CAPABILITY_THRESHOLD,
  DEFAULT_BASELINE,
  IMPLEMENTED_PROVIDERS,
  MODELS_DB,
  calculateSavings,
  getCapableModels,
  getModelByName,
  rankCapableModels,
  selectCheapestModel,
  validateModelsDb,
} from '../../lib/routing/selector.js';

describe('module constants', () => {
  it('CAPABILITY_THRESHOLD is 0.70', () => {
    expect(CAPABILITY_THRESHOLD).toBe(0.70);
  });

  it('IMPLEMENTED_PROVIDERS is exactly {openai, anthropic, google}', () => {
    expect([...IMPLEMENTED_PROVIDERS].sort()).toEqual(['anthropic', 'google', 'openai']);
  });

  it('DEFAULT_BASELINE is the most expensive model in DB by cost_per_1k_input', () => {
    const max = MODELS_DB.reduce(
      (a, b) => (a.cost_per_1k_input >= b.cost_per_1k_input ? a : b),
    );
    expect(DEFAULT_BASELINE).toBe(max.name);
  });

  it('MODELS_DB has at least one google, one openai, one anthropic model', () => {
    const providers = new Set(MODELS_DB.map((m) => m.provider));
    expect(providers.has('google')).toBe(true);
    expect(providers.has('openai')).toBe(true);
    expect(providers.has('anthropic')).toBe(true);
  });
});

describe('validateModelsDb', () => {
  it('accepts valid DB', () => {
    expect(() => validateModelsDb(MODELS_DB)).not.toThrow();
  });

  it('throws on missing provider', () => {
    const bad = [{ name: 'orphan', cost_per_1k_input: 0.001, capabilities: { overall: 0.5 } }];
    expect(() => validateModelsDb(bad)).toThrow(/missing provider/i);
  });

  it('throws on unimplemented provider', () => {
    const bad = [
      {
        name: 'mystery',
        provider: 'cohere',
        cost_per_1k_input: 0.001,
        capabilities: { overall: 0.5 },
      },
    ];
    expect(() => validateModelsDb(bad)).toThrow(/unimplemented providers.*cohere/i);
  });

  it('returns input unchanged on empty DB', () => {
    expect(validateModelsDb([])).toEqual([]);
  });
});

describe('selectCheapestModel', () => {
  it('returns null on empty list', () => {
    expect(selectCheapestModel([])).toBeNull();
    expect(selectCheapestModel(null)).toBeNull();
  });

  it('returns first model on tie (matches Python min stability)', () => {
    const tied = [
      { name: 'a', cost_per_1k_input: 0.001 },
      { name: 'b', cost_per_1k_input: 0.001 },
    ];
    expect(selectCheapestModel(tied).name).toBe('a');
  });
});

describe('rankCapableModels', () => {
  it('returns empty array for empty input', () => {
    expect(rankCapableModels([])).toEqual([]);
  });

  it('sorts by cost_per_1k_input ascending', () => {
    const ranked = rankCapableModels(MODELS_DB);
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i].cost_per_1k_input).toBeGreaterThanOrEqual(ranked[i - 1].cost_per_1k_input);
    }
  });

  it('does not mutate input', () => {
    const before = MODELS_DB.map((m) => m.name);
    rankCapableModels(MODELS_DB);
    expect(MODELS_DB.map((m) => m.name)).toEqual(before);
  });
});

describe('calculateSavings', () => {
  it('returns 0% for selected == baseline', () => {
    const opus = getModelByName('claude-opus-4-6');
    const s = calculateSavings(opus, opus);
    expect(s.savings_percent).toBe(0);
  });

  it('falls back to DEFAULT_BASELINE when baseline not given', () => {
    const cheap = getModelByName('gemini-2.5-flash-lite');
    const s = calculateSavings(cheap);
    expect(s.baseline_model).toBe(DEFAULT_BASELINE);
  });

  it('handles baseline_cost == 0 → savings_percent = 0', () => {
    const free = { name: 'free', cost_per_1k_input: 0, cost_per_1k_output: 0 };
    const s = calculateSavings(free, free);
    expect(s.savings_percent).toBe(0);
  });
});

describe('getCapableModels capability fallback', () => {
  it('uses overall when task-specific score is missing', () => {
    const synthetic = [
      {
        name: 'no-task-cap',
        provider: 'openai',
        cost_per_1k_input: 0.001,
        cost_per_1k_output: 0.005,
        capabilities: { overall: 0.9 }, // no task-specific
      },
    ];
    const capable = getCapableModels('coding', synthetic, 0.85);
    expect(capable.length).toBe(1);
  });

  it('treats missing capabilities entirely as 0 (excluded)', () => {
    const synthetic = [
      { name: 'caps-missing', provider: 'openai', cost_per_1k_input: 0.001, cost_per_1k_output: 0.005, capabilities: {} },
    ];
    expect(getCapableModels('coding', synthetic, 0.5).length).toBe(0);
  });
});
