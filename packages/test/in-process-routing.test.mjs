import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ENV_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY'];
let _saved;

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  _saved = {};
  for (const k of ENV_KEYS) {
    _saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (_saved[k] === undefined) delete process.env[k];
    else process.env[k] = _saved[k];
  }
  // doMock registrations persist across tests even after resetModules, so we
  // must explicitly unmock the paths used by the HTTP-fallback tests below.
  vi.doUnmock('../lib/routing/router.js');
  vi.restoreAllMocks();
});

function makeTelemetry() {
  return { emit: vi.fn(), PLUGIN_VERSION: 'test' };
}

function fakeApi(providers) {
  return { config: providers ? { models: { providers } } : {} };
}

describe('askRouter — happy path (in-process)', () => {
  it('returns {provider, model, savings} from in-process router and emits route_completed', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-real';
    const { askRouter } = await import('../lib/plugin-core.js');
    const telemetry = makeTelemetry();

    const decision = await askRouter('http://localhost:3838', 'write a python function', null, fakeApi(null), telemetry);

    expect(decision.provider).toBeTruthy();
    expect(decision.model).toBeTruthy();
    expect(typeof decision.savings).toBe('number');

    const events = telemetry.emit.mock.calls.map((c) => c[0]);
    expect(events).toContain('route_completed');
    const payload = telemetry.emit.mock.calls.find((c) => c[0] === 'route_completed')[1];
    expect(payload.mode).toBe('in-process');
    expect(payload.provider).toBe('anthropic'); // only anthropic detected
    expect(typeof payload.latency_ms).toBe('number');
    expect(typeof payload.savings_percent).toBe('number');
  });
});

describe('askRouter — empty providers', () => {
  it('emits no_providers_detected and returns null model when nothing is detected', async () => {
    const { askRouter } = await import('../lib/plugin-core.js');
    const telemetry = makeTelemetry();

    const decision = await askRouter('http://localhost:3838', 'hello', null, { config: {} }, telemetry);

    expect(decision).toEqual({ provider: null, model: null, savings: 0 });
    const events = telemetry.emit.mock.calls.map((c) => c[0]);
    expect(events).toContain('no_providers_detected');
    expect(events).not.toContain('route_completed');
  });

  it('has_oc_config flag reflects whether api had a providers object', async () => {
    const { askRouter } = await import('../lib/plugin-core.js');
    const telemetry = makeTelemetry();

    await askRouter('http://localhost:3838', 'hello', null, fakeApi({}), telemetry);
    const event = telemetry.emit.mock.calls.find((c) => c[0] === 'no_providers_detected')[1];
    expect(event.has_oc_config).toBe(true);
  });
});

describe('askRouter — subscription mode intersection', () => {
  it('intersects subscription constraint with detected providers', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-real';
    process.env.OPENAI_API_KEY = 'sk-real';
    const { askRouter } = await import('../lib/plugin-core.js');
    const telemetry = makeTelemetry();

    // subscription mode passes ['anthropic']; even though OpenAI is detected,
    // intersection limits to anthropic
    const decision = await askRouter(
      'http://localhost:3838',
      'write a python function',
      ['anthropic'],
      fakeApi(null),
      telemetry,
    );

    expect(decision.provider).toBe('anthropic');
  });

  it('emits no_providers_detected when subscription constraint excludes everything', async () => {
    process.env.OPENAI_API_KEY = 'sk-real'; // only OpenAI detected
    const { askRouter } = await import('../lib/plugin-core.js');
    const telemetry = makeTelemetry();

    // subscription constraint to anthropic, but only openai is detected
    const decision = await askRouter(
      'http://localhost:3838',
      'hello',
      ['anthropic'],
      fakeApi(null),
      telemetry,
    );

    expect(decision).toEqual({ provider: null, model: null, savings: 0 });
    expect(telemetry.emit.mock.calls.some((c) => c[0] === 'no_providers_detected')).toBe(true);
  });
});

describe('askRouter — HTTP fallback on in-process throw', () => {
  it('falls back to askRouterHttp when in-process throws and emits route_failed', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-real';

    // Mock asyncRoutePrompt to throw
    vi.doMock('../lib/routing/router.js', async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        asyncRoutePrompt: vi.fn().mockRejectedValue(new Error('boom')),
      };
    });

    // Stub fetch so HTTP fallback returns a valid response
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      async json() {
        return { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', savings_percent: 50 };
      },
    }));

    const { askRouter } = await import('../lib/plugin-core.js');
    const telemetry = makeTelemetry();

    const decision = await askRouter(
      'http://localhost:3838',
      'write a function',
      null,
      fakeApi(null),
      telemetry,
    );

    expect(decision).toEqual({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      savings: 50,
    });

    const events = telemetry.emit.mock.calls.map((c) => c[0]);
    expect(events).toContain('route_failed');
    const failPayload = telemetry.emit.mock.calls.find((c) => c[0] === 'route_failed')[1];
    expect(failPayload.mode).toBe('in-process');
    expect(failPayload.error_message).toContain('boom');
    // route_completed should NOT fire when in-process threw
    expect(events).not.toContain('route_completed');
    // fetch was called for HTTP fallback
    expect(globalThis.fetch).toHaveBeenCalled();
    expect(globalThis.fetch.mock.calls[0][0]).toMatch(/\/v1\/route$/);
  });

  it('returns null when both in-process throws AND HTTP returns null', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-real';
    vi.doMock('../lib/routing/router.js', async (importOriginal) => {
      const actual = await importOriginal();
      return { ...actual, asyncRoutePrompt: vi.fn().mockRejectedValue(new Error('boom')) };
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, async json() { return {}; } }));

    const { askRouter } = await import('../lib/plugin-core.js');
    const telemetry = makeTelemetry();

    const decision = await askRouter('http://localhost:3838', 'hi', null, fakeApi(null), telemetry);
    expect(decision).toBeNull();
  });
});

describe('askRouter — classifier_fallback emission via slow path', () => {
  it('emits classifier_fallback with reason="no_key" when slow path runs and the classifier client is disabled', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-real';
    process.env.OPENAI_API_KEY = 'sk-real';
    process.env.GOOGLE_API_KEY = 'sk-real';

    // Disable classifier_client by pointing it at a nonexistent config —
    // getClassifierKey() returns null, classifyWithLlmDetailed surfaces
    // reason='no_key' and emits classifier_fallback to the threaded telemetry.
    const classifierClient = await import('../lib/routing/classifier_client.js');
    classifierClient._resetForTesting('/nonexistent/path/config.json');

    const { askRouter } = await import('../lib/plugin-core.js');
    const telemetry = makeTelemetry();

    // 'write a function' yields keyword confidence 0.8 → slow path runs
    await askRouter('http://localhost:3838', 'write a function', null, fakeApi(null), telemetry);

    const events = telemetry.emit.mock.calls.map((c) => c[0]);
    expect(events).toContain('classifier_fallback');
    const payload = telemetry.emit.mock.calls.find((c) => c[0] === 'classifier_fallback')[1];
    expect(payload.reason).toBe('no_key');
    // route_completed must STILL fire — the classifier failure falls through
    // to keyword-only routing inside asyncRoutePrompt, not a hard error.
    expect(events).toContain('route_completed');
  });
});

describe('askRouter — fast-path optimization', () => {
  it('does NOT emit classifier_fallback on a high-confidence prompt (proves slow path was skipped)', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-real';
    process.env.OPENAI_API_KEY = 'sk-real';
    process.env.GOOGLE_API_KEY = 'sk-real';

    // Disable classifier_client so the slow path WOULD emit classifier_fallback
    // if invoked. Absence of the event proves the keyword fast-path was used.
    const classifierClient = await import('../lib/routing/classifier_client.js');
    classifierClient._resetForTesting('/nonexistent/path/config.json');

    const { askRouter } = await import('../lib/plugin-core.js');
    const telemetry = makeTelemetry();

    // Many coding keywords → confidence saturates at 0.95 → fast path only
    await askRouter(
      'http://localhost:3838',
      'write code to implement a class with a function and method to debug',
      null,
      fakeApi(null),
      telemetry,
    );

    const events = telemetry.emit.mock.calls.map((c) => c[0]);
    expect(events).toContain('route_completed');
    expect(events).not.toContain('classifier_fallback');
  });
});
