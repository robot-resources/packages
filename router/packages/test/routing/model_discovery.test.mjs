import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  discoverAccessibleModels,
  _resetCacheForTesting,
} from '../../lib/routing/model_discovery.js';

beforeEach(() => {
  _resetCacheForTesting();
  vi.unstubAllGlobals();
});

function mockFetchOnce(payloads) {
  const fn = vi.fn();
  for (const p of payloads) {
    if (p.error) {
      fn.mockRejectedValueOnce(p.error);
    } else {
      fn.mockResolvedValueOnce({
        ok: p.ok ?? true,
        status: p.status ?? 200,
        async json() {
          return p.body;
        },
      });
    }
  }
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('discoverAccessibleModels — guard rails', () => {
  it('returns null when api_key is null', async () => {
    expect(await discoverAccessibleModels('openai', null)).toBeNull();
  });

  it('returns null for unknown provider', async () => {
    expect(await discoverAccessibleModels('cohere', 'sk-xxx')).toBeNull();
  });
});

describe('discoverAccessibleModels — openai', () => {
  it('parses data[].id into a Set', async () => {
    mockFetchOnce([{ body: { data: [{ id: 'gpt-5.4' }, { id: 'o3' }] } }]);
    const models = await discoverAccessibleModels('openai', 'sk-xxx');
    expect(models).toBeInstanceOf(Set);
    expect([...models].sort()).toEqual(['gpt-5.4', 'o3']);
  });

  it('returns null on HTTP error', async () => {
    mockFetchOnce([{ ok: false, status: 401, body: {} }]);
    expect(await discoverAccessibleModels('openai', 'sk-bad')).toBeNull();
  });

  it('returns null on network error (never throws)', async () => {
    mockFetchOnce([{ error: new Error('boom') }]);
    expect(await discoverAccessibleModels('openai', 'sk-xxx')).toBeNull();
  });
});

describe('discoverAccessibleModels — anthropic pagination', () => {
  it('follows has_more / last_id chain', async () => {
    mockFetchOnce([
      { body: { data: [{ id: 'claude-haiku-4-5' }], has_more: true, last_id: 'claude-haiku-4-5' } },
      { body: { data: [{ id: 'claude-sonnet-4-6' }, { id: 'claude-opus-4-6' }], has_more: false } },
    ]);
    const models = await discoverAccessibleModels('anthropic', 'sk-ant');
    expect([...models].sort()).toEqual(['claude-haiku-4-5', 'claude-opus-4-6', 'claude-sonnet-4-6']);
  });

  it('stops on missing last_id', async () => {
    mockFetchOnce([
      { body: { data: [{ id: 'claude-haiku' }], has_more: true /* no last_id */ } },
    ]);
    const models = await discoverAccessibleModels('anthropic', 'sk-ant');
    expect([...models]).toEqual(['claude-haiku']);
  });
});

describe('discoverAccessibleModels — google', () => {
  it("strips 'models/' prefix", async () => {
    mockFetchOnce([
      { body: { models: [{ name: 'models/gemini-2.5-pro' }, { name: 'models/gemini-2.5-flash' }] } },
    ]);
    const models = await discoverAccessibleModels('google', 'AIza-xxx');
    expect([...models].sort()).toEqual(['gemini-2.5-flash', 'gemini-2.5-pro']);
  });

  it('follows nextPageToken', async () => {
    mockFetchOnce([
      { body: { models: [{ name: 'models/a' }], nextPageToken: 'tok-1' } },
      { body: { models: [{ name: 'models/b' }] } },
    ]);
    const models = await discoverAccessibleModels('google', 'AIza-xxx');
    expect([...models].sort()).toEqual(['a', 'b']);
  });
});

describe('discoverAccessibleModels — cache', () => {
  it('caches by (provider, key_hash) and returns same Set on second call', async () => {
    const fetchFn = mockFetchOnce([{ body: { data: [{ id: 'gpt-5.4' }] } }]);
    const a = await discoverAccessibleModels('openai', 'sk-aaa');
    const b = await discoverAccessibleModels('openai', 'sk-aaa');
    expect(a).toBe(b);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('different keys produce separate cache entries', async () => {
    mockFetchOnce([
      { body: { data: [{ id: 'gpt-5.4' }] } },
      { body: { data: [{ id: 'o3' }] } },
    ]);
    const a = await discoverAccessibleModels('openai', 'sk-aaa');
    const b = await discoverAccessibleModels('openai', 'sk-bbb');
    expect([...a]).toEqual(['gpt-5.4']);
    expect([...b]).toEqual(['o3']);
  });
});
