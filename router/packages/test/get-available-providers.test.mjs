import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getAvailableProviders } from '../lib/plugin-core.js';

const ENV_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY'];

let _saved;

beforeEach(() => {
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
});

function fakeApi(providers) {
  return { config: { models: { providers } } };
}

describe('getAvailableProviders — env-var detection', () => {
  it('detects anthropic from ANTHROPIC_API_KEY', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-real';
    expect([...getAvailableProviders(fakeApi({}))].sort()).toEqual(['anthropic']);
  });

  it('detects openai from OPENAI_API_KEY', () => {
    process.env.OPENAI_API_KEY = 'sk-real';
    expect([...getAvailableProviders(fakeApi({}))].sort()).toEqual(['openai']);
  });

  it('detects google from GOOGLE_API_KEY OR GEMINI_API_KEY', () => {
    process.env.GOOGLE_API_KEY = 'AIza-real';
    expect([...getAvailableProviders(fakeApi({}))].sort()).toEqual(['google']);
    delete process.env.GOOGLE_API_KEY;
    process.env.GEMINI_API_KEY = 'AIza-real';
    expect([...getAvailableProviders(fakeApi({}))].sort()).toEqual(['google']);
  });
});

describe('getAvailableProviders — OC config detection', () => {
  it('detects providers from object-keyed api.config.models.providers', () => {
    const api = fakeApi({
      anthropic: { apiKey: 'sk-ant-real' },
      openai: { apiKey: 'sk-real' },
    });
    expect([...getAvailableProviders(api)].sort()).toEqual(['anthropic', 'openai']);
  });

  it('accepts both apiKey and api_key field names', () => {
    const api = fakeApi({
      anthropic: { api_key: 'sk-ant-real' },
      openai: { apiKey: 'sk-real' },
    });
    expect([...getAvailableProviders(api)].sort()).toEqual(['anthropic', 'openai']);
  });

  it('filters out the "n/a" sentinel (used by registered proxy providers)', () => {
    const api = fakeApi({
      'robot-resources': { apiKey: 'n/a' },
      anthropic: { apiKey: 'sk-real' },
    });
    expect([...getAvailableProviders(api)].sort()).toEqual(['anthropic']);
  });

  it('filters out empty strings', () => {
    const api = fakeApi({ anthropic: { apiKey: '' } });
    expect([...getAvailableProviders(api)]).toEqual([]);
  });

  it('filters out ${VAR} template placeholders', () => {
    const api = fakeApi({ anthropic: { apiKey: '${ANTHROPIC_API_KEY}' } });
    expect([...getAvailableProviders(api)]).toEqual([]);
  });

  it('filters out YOUR_KEY placeholders', () => {
    const api = fakeApi({ openai: { apiKey: 'YOUR_OPENAI_API_KEY_HERE' } });
    expect([...getAvailableProviders(api)]).toEqual([]);
  });
});

describe('getAvailableProviders — hybrid union', () => {
  it('unions config-detected and env-detected providers', () => {
    process.env.OPENAI_API_KEY = 'sk-real';
    const api = fakeApi({ anthropic: { apiKey: 'sk-ant-real' } });
    expect([...getAvailableProviders(api)].sort()).toEqual(['anthropic', 'openai']);
  });

  it('deduplicates when both sources have the same provider', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env';
    const api = fakeApi({ anthropic: { apiKey: 'sk-ant-config' } });
    expect([...getAvailableProviders(api)]).toEqual(['anthropic']);
  });
});

describe('getAvailableProviders — defensive fallbacks', () => {
  it('returns empty Set when no env vars and no config', () => {
    expect([...getAvailableProviders({ config: {} })]).toEqual([]);
  });

  it('returns empty Set when api is null', () => {
    expect([...getAvailableProviders(null)]).toEqual([]);
  });

  it('ignores providers field if it is an array (wrong schema)', () => {
    const api = { config: { models: { providers: [{ id: 'anthropic', apiKey: 'sk' }] } } };
    expect([...getAvailableProviders(api)]).toEqual([]);
  });

  it('swallows malformed config without throwing', () => {
    const api = { config: { models: { providers: { broken: { get apiKey() { throw new Error('boom'); } } } } } };
    expect(() => getAvailableProviders(api)).not.toThrow();
  });
});
