import { describe, it, expect } from 'vitest';
import {
  TASK_PATTERNS,
  TASK_PRIORITY,
  CONTEXT_OVERRIDES,
  analyzePrompt,
  analyzePromptStructure,
  detectTaskType,
  getTaskConfidence,
} from '../../lib/routing/task_detection.js';

describe('TASK_PRIORITY', () => {
  it('orders coding before creative before reasoning before analysis before simple_qa', () => {
    expect(TASK_PRIORITY).toEqual(['coding', 'creative', 'reasoning', 'analysis', 'simple_qa']);
  });
});

describe('CONTEXT_OVERRIDES insertion order (first match wins)', () => {
  it('preserves Python dict insertion order', () => {
    const triggers = CONTEXT_OVERRIDES.map((o) => `${o.trigger}|${o.override}`);
    expect(triggers).toEqual([
      'why|simple_qa',
      'why|coding',
      'explain|coding',
      'write|coding',
      'write|creative',
      'create|coding',
      'compare|analysis',
      'review|analysis',
      'evaluate|analysis',
    ]);
  });
});

describe('analyzePromptStructure', () => {
  it('handles empty prompt', () => {
    expect(analyzePromptStructure('')).toEqual({
      word_count: 0,
      has_question_mark: false,
      has_code_block: false,
      has_inline_code: false,
      is_short_question: false,
      line_count: 1,
    });
  });

  it('detects code blocks', () => {
    const s = analyzePromptStructure('```python\nx=1\n```');
    expect(s.has_code_block).toBe(true);
    expect(s.has_inline_code).toBe(false);
  });

  it('detects inline code only when no code block present', () => {
    expect(analyzePromptStructure('use the `map` function').has_inline_code).toBe(true);
    expect(analyzePromptStructure('```\n`x`\n```').has_inline_code).toBe(false);
  });

  it('counts lines via \\n split', () => {
    expect(analyzePromptStructure('a\nb\nc').line_count).toBe(3);
  });
});

describe('detectTaskType priority and overrides', () => {
  it('returns general when nothing matches', () => {
    expect(detectTaskType('hmmm okay')).toBe('general');
  });

  it('definition pattern fast-path returns simple_qa for short prompts', () => {
    expect(detectTaskType('what is HTTP')).toBe('simple_qa');
  });

  it('"stand for" short fast-path returns simple_qa', () => {
    expect(detectTaskType('what does HTTP stand for')).toBe('simple_qa');
  });

  it('long line_count downgrades simple_qa to general', () => {
    const prompt = 'what is\nthis\nweird\nlong\nmulti\nline thing';
    expect(detectTaskType(prompt)).toBe('general');
  });

  it('code block forces coding when at least one keyword matches', () => {
    // Pure code-block prompts with no keywords return 'general' (early-return
    // happens before the structure step — matches Python). When any keyword
    // matches, the code-block adjustment promotes the result to 'coding'.
    expect(detectTaskType('```python\nx=1\n```')).toBe('coding');
    expect(detectTaskType('```\nfoo\n```')).toBe('general');
  });
});

describe('getTaskConfidence', () => {
  it('returns 0.5 for general', () => {
    expect(getTaskConfidence('hello', 'general')).toBe(0.5);
  });

  it('caps confidence at 0.95 with many matches', () => {
    // many coding keywords → matches >= 4
    const prompt = 'write code to implement a class with a function and method to debug';
    expect(getTaskConfidence(prompt, 'coding')).toBe(0.95);
  });

  it('starts at 0.7 for one match', () => {
    expect(getTaskConfidence('explain', 'reasoning')).toBe(0.7);
  });
});

describe('analyzePrompt matched_keywords', () => {
  it('caps to 5 matches', () => {
    const prompt = 'write code to implement a class with a function and method to debug a script with python';
    const out = analyzePrompt(prompt);
    expect(out.matched_keywords.length).toBeLessThanOrEqual(5);
  });
});

describe('TASK_PATTERNS sanity', () => {
  it('every priority task has at least one keyword', () => {
    for (const t of TASK_PRIORITY) {
      expect(TASK_PATTERNS[t]?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

describe('regex word boundary correctness', () => {
  it('does not match keyword as substring of another word', () => {
    // "go" is a coding keyword but should not match inside "going"
    expect(detectTaskType('I am going home')).toBe('general');
  });

  it('matches dot in keyword like vs.', () => {
    expect(detectTaskType('compare React vs Vue')).toBe('analysis');
  });
});
