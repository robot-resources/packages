import { describe, it, expect } from 'vitest';
import {
  CONFIDENCE_THRESHOLD,
  COMPLEXITY_THRESHOLD_MAP,
  asyncRoutePrompt,
  routePrompt,
} from '../../lib/routing/router.js';
import { CAPABILITY_THRESHOLD } from '../../lib/routing/selector.js';

describe('plan-doc invariants', () => {
  it('CONFIDENCE_THRESHOLD is 0.85', () => {
    expect(CONFIDENCE_THRESHOLD).toBe(0.85);
  });

  it('COMPLEXITY_THRESHOLD_MAP uses 0.60 / 0.70 / 0.85 buckets', () => {
    expect(COMPLEXITY_THRESHOLD_MAP[1]).toBe(0.60);
    expect(COMPLEXITY_THRESHOLD_MAP[2]).toBe(0.60);
    expect(COMPLEXITY_THRESHOLD_MAP[3]).toBe(0.70);
    expect(COMPLEXITY_THRESHOLD_MAP[4]).toBe(0.85);
    expect(COMPLEXITY_THRESHOLD_MAP[5]).toBe(0.85);
  });

  it('CAPABILITY_THRESHOLD default is 0.70', () => {
    expect(CAPABILITY_THRESHOLD).toBe(0.70);
  });
});

describe('routePrompt — sync, fallback chain', () => {
  it('returns a routing decision with all expected keys', () => {
    const r = routePrompt('write a python function');
    expect(r).toHaveProperty('selected_model');
    expect(r).toHaveProperty('provider');
    expect(r).toHaveProperty('cost_per_1k_input');
    expect(r).toHaveProperty('cost_per_1k_output');
    expect(r).toHaveProperty('baseline_model');
    expect(r).toHaveProperty('savings_percent');
    expect(r).toHaveProperty('task_type');
    expect(r).toHaveProperty('capability_score');
    expect(r).toHaveProperty('detection_confidence');
    expect(r).toHaveProperty('reasoning');
    expect(r).toHaveProperty('matched_keywords');
    expect(r).toHaveProperty('max_tokens');
    expect(r).toHaveProperty('ranked_candidates');
  });

  it('falls back to threshold 0.5 when no model meets the requested threshold', () => {
    // With an absurd threshold, no models from the real DB will pass.
    // Pipeline should still return a routing decision (final fallback to entire DB).
    const r = routePrompt('hello', { threshold: 0.99 });
    expect(r.selected_model).toBeTruthy();
  });

  it('forces task_type=general when even the 0.5 fallback is empty for the task', () => {
    // Use a tiny synthetic DB whose only model has low capabilities — all
    // capable_models lookups will be empty and the pipeline should return
    // task_type='general'.
    const tinyDb = [
      {
        name: 'too-weak',
        provider: 'openai',
        cost_per_1k_input: 0.001,
        cost_per_1k_output: 0.005,
        max_tokens: 100000,
        capabilities: { overall: 0.1, coding: 0.1, reasoning: 0.1, analysis: 0.1, simple_qa: 0.1, creative: 0.1 },
        last_updated: '2026-04-24',
      },
    ];
    const r = routePrompt('write code', { modelsDb: tinyDb });
    expect(r.task_type).toBe('general');
    expect(r.selected_model).toBe('too-weak');
  });
});

describe('asyncRoutePrompt — slow path branching', () => {
  it('skips classifier on high keyword confidence', async () => {
    let called = false;
    const stub = async () => {
      called = true;
      return { taskType: 'coding', complexity: 5, classifierModel: 'g' };
    };
    // High-confidence prompt: many coding keywords -> conf 0.95 (>= 0.85)
    const r = await asyncRoutePrompt(
      'write code to implement a class with a function and method to debug',
      { classifierImpl: stub },
    );
    expect(called).toBe(false);
    expect(r.classification_source).toBe('keyword');
  });

  it('uses classifier when keyword confidence is low and classifier disagrees', async () => {
    const stub = async () => ({ taskType: 'analysis', complexity: 3, classifierModel: 'g' });
    const r = await asyncRoutePrompt('write a function', { classifierImpl: stub });
    // 'write a function' yields keyword 'coding' with confidence 0.8 (<0.85) → slow path runs
    expect(r.classification_source).toBe('llm');
    expect(r.task_type).toBe('analysis');
    expect(r.capability_threshold).toBe(0.70); // complexity=3 → 0.70
  });

  it('keeps keyword task type when classifier agrees, but adjusts threshold by complexity', async () => {
    const stub = async () => ({ taskType: 'coding', complexity: 5, classifierModel: 'g' });
    const r = await asyncRoutePrompt('write a function', { classifierImpl: stub });
    expect(r.classification_source).toBe('keyword');
    expect(r.task_type).toBe('coding');
    expect(r.capability_threshold).toBe(0.85); // complexity=5 → 0.85
  });

  it('falls back to keyword when classifier returns null', async () => {
    const stub = async () => null;
    const r = await asyncRoutePrompt('write a function', { classifierImpl: stub });
    expect(r.classification_source).toBe('keyword');
    expect(r.llm_task_type).toBeNull();
  });

  it('swallows classifier exceptions', async () => {
    const stub = async () => {
      throw new Error('classifier exploded');
    };
    const r = await asyncRoutePrompt('write a function', { classifierImpl: stub });
    expect(r.classification_source).toBe('keyword');
    expect(r.llm_task_type).toBeNull();
  });
});

describe('plan invariant: model_discovery filters to (catalog ∩ user-accessible)', () => {
  // routePrompt accepts a modelsDb; passing the intersection from caller-side
  // is the contract the plugin will use in PR2. This test asserts the
  // selector path respects caller-supplied DB exclusively.
  it('routes only within the caller-supplied modelsDb', () => {
    const restricted = [
      {
        name: 'only-this',
        provider: 'openai',
        cost_per_1k_input: 0.0001,
        cost_per_1k_output: 0.0004,
        max_tokens: 100000,
        capabilities: { overall: 0.99, coding: 0.99, reasoning: 0.99, analysis: 0.99, simple_qa: 0.99, creative: 0.99 },
        last_updated: '2026-04-24',
      },
    ];
    const r = routePrompt('write a python function', { modelsDb: restricted });
    expect(r.selected_model).toBe('only-this');
  });
});
