import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmpHome;
let configPath;

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  tmpHome = mkdtempSync(join(tmpdir(), 'rr-classifier-'));
  mkdirSync(join(tmpHome, '.robot-resources'));
  configPath = join(tmpHome, '.robot-resources', 'config.json');
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

async function loadModuleWithConfig(configContent) {
  if (configContent !== null) {
    writeFileSync(configPath, configContent);
  }
  const mod = await import('../../lib/routing/classifier_client.js');
  mod._resetForTesting(configPath);
  return mod;
}

describe('module load is graceful when config.json is missing', () => {
  it('does not throw on import; isEnabled() returns false; getClassifierKey() returns null', async () => {
    // No config file at the path
    const mod = await import('../../lib/routing/classifier_client.js');
    mod._resetForTesting(join(tmpHome, '.robot-resources', 'does-not-exist.json'));
    expect(mod.isEnabled()).toBe(false);
    expect(await mod.getClassifierKey()).toBeNull();
  });

  it('does not throw on malformed JSON; disables silently', async () => {
    const mod = await loadModuleWithConfig('{not valid json');
    expect(mod.isEnabled()).toBe(false);
    expect(await mod.getClassifierKey()).toBeNull();
  });

  it('disables when api_key is missing or empty', async () => {
    const mod = await loadModuleWithConfig(JSON.stringify({ api_key: '' }));
    expect(mod.isEnabled()).toBe(false);
  });

  it('disables when platform_url host is not allowlisted', async () => {
    const mod = await loadModuleWithConfig(
      JSON.stringify({ api_key: 'rr-xxx', platform_url: 'https://evil.example.com' }),
    );
    expect(mod.isEnabled()).toBe(false);
  });

  it('enables when platform_url is api.robotresources.ai', async () => {
    const mod = await loadModuleWithConfig(
      JSON.stringify({ api_key: 'rr-xxx', platform_url: 'https://api.robotresources.ai' }),
    );
    expect(mod.isEnabled()).toBe(true);
  });
});

describe('getClassifierKey caching + retry backoff', () => {
  function stubFetch(responses) {
    const fn = vi.fn();
    for (const r of responses) {
      if (r.error) fn.mockRejectedValueOnce(r.error);
      else fn.mockResolvedValueOnce({ status: r.status ?? 200, async json() { return r.body; } });
    }
    vi.stubGlobal('fetch', fn);
    return fn;
  }

  it('returns cached key on second call within TTL', async () => {
    const mod = await loadModuleWithConfig(JSON.stringify({ api_key: 'rr-xxx' }));
    const fetchFn = stubFetch([
      { body: { data: { provider: 'google', model: 'gemini-1.5-flash-8b', api_key: 'AIza-yyy' } } },
    ]);
    const a = await mod.getClassifierKey();
    const b = await mod.getClassifierKey();
    expect(a).toBe(b);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('returns null when platform returns non-200', async () => {
    const mod = await loadModuleWithConfig(JSON.stringify({ api_key: 'rr-xxx' }));
    stubFetch([{ status: 503, body: {} }]);
    expect(await mod.getClassifierKey()).toBeNull();
  });

  it('returns null when response is missing required fields', async () => {
    const mod = await loadModuleWithConfig(JSON.stringify({ api_key: 'rr-xxx' }));
    stubFetch([{ body: { data: { provider: 'google' } } }]); // missing model + api_key
    expect(await mod.getClassifierKey()).toBeNull();
  });
});

describe('parseClassification', () => {
  it('parses plain JSON', async () => {
    const mod = await loadModuleWithConfig(JSON.stringify({ api_key: 'rr-xxx' }));
    const out = mod.parseClassification('{"task_type": "coding", "complexity": 3}', 'gemini');
    expect(out).toEqual({ taskType: 'coding', complexity: 3, classifierModel: 'gemini' });
  });

  it('strips markdown fences (```json ... ```)', async () => {
    const mod = await loadModuleWithConfig(JSON.stringify({ api_key: 'rr-xxx' }));
    const text = '```json\n{"task_type": "reasoning", "complexity": 4}\n```';
    expect(mod.parseClassification(text, 'gemini')).toEqual({
      taskType: 'reasoning',
      complexity: 4,
      classifierModel: 'gemini',
    });
  });

  it('clamps complexity to 1..5', async () => {
    const mod = await loadModuleWithConfig(JSON.stringify({ api_key: 'rr-xxx' }));
    expect(mod.parseClassification('{"task_type":"coding","complexity":99}', 'g').complexity).toBe(5);
    expect(mod.parseClassification('{"task_type":"coding","complexity":-3}', 'g').complexity).toBe(1);
  });

  it('rejects invalid task_type', async () => {
    const mod = await loadModuleWithConfig(JSON.stringify({ api_key: 'rr-xxx' }));
    expect(mod.parseClassification('{"task_type":"banana","complexity":3}', 'g')).toBeNull();
  });

  it('rejects non-numeric complexity', async () => {
    const mod = await loadModuleWithConfig(JSON.stringify({ api_key: 'rr-xxx' }));
    expect(mod.parseClassification('{"task_type":"coding","complexity":"hard"}', 'g')).toBeNull();
  });

  it('returns null on malformed JSON', async () => {
    const mod = await loadModuleWithConfig(JSON.stringify({ api_key: 'rr-xxx' }));
    expect(mod.parseClassification('not json at all', 'g')).toBeNull();
  });
});
