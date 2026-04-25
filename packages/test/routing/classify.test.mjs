import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function loadClassifyWithMocks(mocks) {
  vi.doMock('../../lib/routing/classifier_client.js', () => ({
    getClassifierKey: mocks.getClassifierKey ?? vi.fn(),
    callGemini: mocks.callGemini ?? vi.fn(),
    parseClassification: mocks.parseClassification ?? vi.fn(),
  }));
  return await import('../../lib/routing/classify.js');
}

describe('classifyWithLlmDetailed reason tracking', () => {
  it('returns reason="empty_prompt" for blank input and never emits telemetry', async () => {
    const telemetry = { emit: vi.fn() };
    const { classifyWithLlmDetailed } = await loadClassifyWithMocks({});
    const out = await classifyWithLlmDetailed('   ', { telemetry });
    expect(out).toEqual({ result: null, reason: 'empty_prompt' });
    expect(telemetry.emit).not.toHaveBeenCalled();
  });

  it('returns reason="no_key" when getClassifierKey returns null', async () => {
    const telemetry = { emit: vi.fn() };
    const { classifyWithLlmDetailed } = await loadClassifyWithMocks({
      getClassifierKey: vi.fn().mockResolvedValue(null),
    });
    const promise = classifyWithLlmDetailed('classify me', { telemetry });
    await vi.runAllTimersAsync();
    const out = await promise;
    expect(out).toEqual({ result: null, reason: 'no_key' });
    expect(telemetry.emit).toHaveBeenCalledWith('classifier_fallback', { reason: 'no_key' });
  });

  it('returns reason="provider_not_google" for non-google key info', async () => {
    const telemetry = { emit: vi.fn() };
    const { classifyWithLlmDetailed } = await loadClassifyWithMocks({
      getClassifierKey: vi.fn().mockResolvedValue({ provider: 'anthropic', model: 'claude-x', apiKey: 'k' }),
    });
    const out = await classifyWithLlmDetailed('classify me', { telemetry });
    expect(out.reason).toBe('provider_not_google');
    expect(telemetry.emit).toHaveBeenCalledWith('classifier_fallback', { reason: 'provider_not_google' });
  });

  it('returns reason="network_error" when callGemini throws', async () => {
    const telemetry = { emit: vi.fn() };
    const { classifyWithLlmDetailed } = await loadClassifyWithMocks({
      getClassifierKey: vi.fn().mockResolvedValue({ provider: 'google', model: 'gemini-1.5-flash-8b', apiKey: 'k' }),
      callGemini: vi.fn().mockRejectedValue(new Error('boom')),
    });
    const out = await classifyWithLlmDetailed('classify me', { telemetry });
    expect(out.reason).toBe('network_error');
    expect(telemetry.emit).toHaveBeenCalledWith('classifier_fallback', { reason: 'network_error' });
  });

  it('returns reason="parse_error" when parseClassification returns null', async () => {
    const telemetry = { emit: vi.fn() };
    const { classifyWithLlmDetailed } = await loadClassifyWithMocks({
      getClassifierKey: vi.fn().mockResolvedValue({ provider: 'google', model: 'gemini-1.5-flash-8b', apiKey: 'k' }),
      callGemini: vi.fn().mockResolvedValue('garbage'),
      parseClassification: vi.fn().mockReturnValue(null),
    });
    const out = await classifyWithLlmDetailed('classify me', { telemetry });
    expect(out.reason).toBe('parse_error');
    expect(telemetry.emit).toHaveBeenCalledWith('classifier_fallback', { reason: 'parse_error' });
  });

  it('returns reason="timeout" when _classifyImpl exceeds 2s', async () => {
    const telemetry = { emit: vi.fn() };
    const slowGemini = () => new Promise((resolve) => setTimeout(() => resolve('{}'), 5_000));
    const { classifyWithLlmDetailed } = await loadClassifyWithMocks({
      getClassifierKey: vi.fn().mockResolvedValue({ provider: 'google', model: 'gemini-1.5-flash-8b', apiKey: 'k' }),
      callGemini: vi.fn().mockImplementation(slowGemini),
      parseClassification: vi.fn().mockReturnValue({ taskType: 'coding', complexity: 3, classifierModel: 'g' }),
    });
    const promise = classifyWithLlmDetailed('classify me', { telemetry });
    await vi.advanceTimersByTimeAsync(2_100);
    const out = await promise;
    expect(out.reason).toBe('timeout');
    expect(telemetry.emit).toHaveBeenCalledWith('classifier_fallback', { reason: 'timeout' });
  });

  it('returns success with reason=null when everything works', async () => {
    const telemetry = { emit: vi.fn() };
    const { classifyWithLlmDetailed } = await loadClassifyWithMocks({
      getClassifierKey: vi.fn().mockResolvedValue({ provider: 'google', model: 'gemini-1.5-flash-8b', apiKey: 'k' }),
      callGemini: vi.fn().mockResolvedValue('{"task_type":"coding","complexity":3}'),
      parseClassification: vi.fn().mockReturnValue({ taskType: 'coding', complexity: 3, classifierModel: 'gemini-1.5-flash-8b' }),
    });
    const out = await classifyWithLlmDetailed('classify me', { telemetry });
    expect(out.reason).toBeNull();
    expect(out.result).toEqual({ taskType: 'coding', complexity: 3, classifierModel: 'gemini-1.5-flash-8b' });
    expect(telemetry.emit).not.toHaveBeenCalled();
  });

  it('does NOT emit telemetry when telemetry option is omitted', async () => {
    const { classifyWithLlmDetailed } = await loadClassifyWithMocks({
      getClassifierKey: vi.fn().mockResolvedValue(null),
    });
    const out = await classifyWithLlmDetailed('classify me');
    expect(out.reason).toBe('no_key');
    // No assertion on telemetry — proving absence is via not throwing.
  });
});

describe('classifyWithLlm backwards-compat wrapper', () => {
  it('returns just the result on success', async () => {
    const { classifyWithLlm } = await loadClassifyWithMocks({
      getClassifierKey: vi.fn().mockResolvedValue({ provider: 'google', model: 'g', apiKey: 'k' }),
      callGemini: vi.fn().mockResolvedValue('{"task_type":"coding","complexity":2}'),
      parseClassification: vi.fn().mockReturnValue({ taskType: 'coding', complexity: 2, classifierModel: 'g' }),
    });
    const out = await classifyWithLlm('hello');
    expect(out).toEqual({ taskType: 'coding', complexity: 2, classifierModel: 'g' });
  });

  it('returns null on any failure (parity with PR1 contract)', async () => {
    const { classifyWithLlm } = await loadClassifyWithMocks({
      getClassifierKey: vi.fn().mockResolvedValue(null),
    });
    expect(await classifyWithLlm('hello')).toBeNull();
  });
});
