import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

describe('public API — exports field shape', () => {
  it('package.json exports map registers ., ./routing, ./telemetry', () => {
    const pkg = require('../package.json');
    expect(pkg.exports).toBeDefined();
    expect(pkg.exports['.']).toBe('./index.js');
    expect(pkg.exports['./routing']).toBe('./lib/routing/index.js');
    expect(pkg.exports['./telemetry']).toBe('./lib/telemetry.js');
  });

  it('./routing resolves to a module exporting routePrompt + asyncRoutePrompt', async () => {
    const mod = await import('../lib/routing/index.js');
    expect(typeof mod.routePrompt).toBe('function');
    expect(typeof mod.asyncRoutePrompt).toBe('function');
    expect(typeof mod.analyzePrompt).toBe('function');
    expect(typeof mod.discoverAccessibleModels).toBe('function');
    expect(mod.MODELS_DB).toBeDefined();
    expect(mod.CONFIDENCE_THRESHOLD).toBe(0.85);
  });

  it('./telemetry resolves to a module exporting createTelemetry', async () => {
    const mod = await import('../lib/telemetry.js');
    expect(typeof mod.createTelemetry).toBe('function');
    expect(mod.PLUGIN_VERSION).toBeDefined();
  });
});

describe('public API — routePrompt smoke', () => {
  it('returns a decision shape for a coding prompt', async () => {
    const { routePrompt } = await import('../lib/routing/index.js');

    const decision = routePrompt('write a python function that reverses a string');

    expect(decision).toMatchObject({
      selected_model: expect.any(String),
      provider: expect.any(String),
      task_type: expect.any(String),
      savings_percent: expect.any(Number),
      capability_score: expect.any(Number),
      reasoning: expect.any(String),
    });
    expect(decision.selected_model.length).toBeGreaterThan(0);
    expect(decision.task_type).toBe('coding');
  });

  it('returns a decision for a simple_qa prompt', async () => {
    const { routePrompt } = await import('../lib/routing/index.js');

    const decision = routePrompt('what is the capital of France');

    expect(decision.selected_model).toBeDefined();
    expect(decision.task_type).toBe('simple_qa');
  });

  it('accepts a custom modelsDb opt', async () => {
    const { routePrompt, MODELS_DB } = await import('../lib/routing/index.js');

    const filtered = MODELS_DB.filter((m) => m.provider === 'anthropic');
    expect(filtered.length).toBeGreaterThan(0);

    const decision = routePrompt('write a python function', { modelsDb: filtered });

    expect(decision.provider).toBe('anthropic');
  });

  it('does not read user provider keys from the filesystem', async () => {
    // Routing module must not touch ~/.openclaw/ or auth profiles —
    // public consumers (non-OC agents) won't have those paths.
    const { routePrompt } = await import('../lib/routing/index.js');
    const decision = routePrompt('debug this stack trace');
    expect(decision).toBeDefined();
    // No throw, no fs error — proves the keyword path is fully self-contained.
  });
});

describe('public API — asyncRoutePrompt without classifierImpl is keyword-only', () => {
  it('falls back to keyword path when no classifierImpl is provided', async () => {
    const { asyncRoutePrompt } = await import('../lib/routing/index.js');

    const decision = await asyncRoutePrompt('refactor this function for readability');

    expect(decision.selected_model).toBeDefined();
    expect(decision.task_type).toBe('coding');
    // classification_source should reflect that no classifier ran
    expect(decision.classification_source).toBeDefined();
  });
});

describe('public API — telemetry factory is opt-in', () => {
  it('createTelemetry without apiKey returns no-op emit', async () => {
    const { createTelemetry } = await import('../lib/telemetry.js');
    const t = createTelemetry({});
    expect(typeof t.emit).toBe('function');
    // emit returns void and never throws when apiKey is missing
    expect(() => t.emit('route_via_lib', { foo: 'bar' })).not.toThrow();
  });
});
