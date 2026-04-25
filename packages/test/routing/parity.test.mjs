import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyzePrompt, analyzePromptStructure } from '../../lib/routing/task_detection.js';
import {
  MODELS_DB,
  calculateSavings,
  getCapableModels,
  getModelByName,
  rankCapableModels,
  selectCheapestModel,
} from '../../lib/routing/selector.js';
import { asyncRoutePrompt, routePrompt } from '../../lib/routing/router.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures');

const taskDetection = JSON.parse(readFileSync(join(FIXTURES, 'task_detection.json'), 'utf-8'));
const selector = JSON.parse(readFileSync(join(FIXTURES, 'selector.json'), 'utf-8'));
const router = JSON.parse(readFileSync(join(FIXTURES, 'router.json'), 'utf-8'));
const routerAsync = JSON.parse(readFileSync(join(FIXTURES, 'router_async.json'), 'utf-8'));

describe('parity: task_detection (analyze_prompt + analyze_prompt_structure)', () => {
  it.each(taskDetection)('matches Python for: $prompt', ({ prompt, expected }) => {
    const analysis = analyzePrompt(prompt);
    const structure = analyzePromptStructure(prompt);
    expect(analysis.task_type).toBe(expected.task_type);
    expect(analysis.confidence).toBe(expected.confidence);
    expect(analysis.matched_keywords).toEqual(expected.matched_keywords);
    expect(structure).toEqual(expected.structure);
  });
});

describe('parity: selector', () => {
  for (const fixture of selector) {
    if (fixture.kind === 'capable') {
      it(`capable[${fixture.task_type} @ ${fixture.threshold}] matches Python`, () => {
        const capable = getCapableModels(fixture.task_type, MODELS_DB, fixture.threshold);
        expect(capable.length).toBe(fixture.expected.count);
        expect(capable.map((m) => m.name).sort()).toEqual(fixture.expected.names);
      });
    } else if (fixture.kind === 'cheapest') {
      it(`cheapest[${fixture.task_type} @ ${fixture.threshold}] matches Python`, () => {
        const capable = getCapableModels(fixture.task_type, MODELS_DB, fixture.threshold);
        const cheapest = selectCheapestModel(capable);
        const ranked = rankCapableModels(capable);
        expect(cheapest?.name ?? null).toBe(fixture.expected.selected);
        expect(ranked.map((m) => m.name)).toEqual(fixture.expected.ranked_names);
      });
    } else if (fixture.kind === 'savings') {
      it(`savings[${fixture.selected} vs ${fixture.baseline}] matches Python`, () => {
        const selected = getModelByName(fixture.selected);
        const baseline = getModelByName(fixture.baseline);
        const savings = calculateSavings(selected, baseline);
        expect(savings).toEqual(fixture.expected);
      });
    } else if (fixture.kind === 'capable_synthetic') {
      it(`capable_synthetic[${fixture.task_type} @ ${fixture.threshold}] (IEEE-754 boundary) matches Python`, () => {
        const capable = getCapableModels(
          fixture.task_type,
          fixture.synthetic_models,
          fixture.threshold,
        );
        expect(capable.length).toBe(fixture.expected.count);
        expect(capable.map((m) => m.name).sort()).toEqual(fixture.expected.names);
      });
    } else {
      it.fails(`unknown selector fixture kind: ${fixture.kind}`, () => {});
    }
  }
});

describe('parity: routePrompt (sync, no LLM)', () => {
  it.each(router)('matches Python for: $prompt', ({ prompt, expected }) => {
    const result = routePrompt(prompt);
    expect(result).toEqual(expected);
  });
});

describe('parity: asyncRoutePrompt (mocked classifier)', () => {
  it.each(routerAsync)(
    'matches Python for: $prompt (mocked_llm=$mocked_llm)',
    async ({ prompt, mocked_llm, expected }) => {
      const classifierImpl = async () => {
        if (mocked_llm == null) return null;
        return {
          taskType: mocked_llm.task_type,
          complexity: mocked_llm.complexity,
          classifierModel: mocked_llm.classifier_model,
        };
      };
      const result = await asyncRoutePrompt(prompt, { classifierImpl });
      expect(result).toEqual(expected);
    },
  );
});
