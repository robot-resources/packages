/**
 * OC Catalog Dispatch — integration tests.
 *
 * Two distinct things this file backstops:
 *
 *   1. PR 2 regression net. PR 2 (April 2026) shipped a non-functional
 *      plugin live to npm because tests asserted register() ran but never
 *      that catalog.run() resolved or that the bound server actually
 *      received dispatched requests. The harness checks below boot the
 *      real local server, await catalog.run(), and POST through Node's
 *      http client to the returned baseUrl — proving the dispatch path
 *      end-to-end. If a future OC SDK update silently breaks this path,
 *      these tests fail loudly.
 *
 *   2. Multi-lab dispatch (PR A scope). The plugin registers three
 *      virtual models — auto-anthropic / auto-openai / auto-google —
 *      each with its lab-native OC api string and path-prefixed
 *      loopback baseUrl. Tests assert each shape forwards to the right
 *      upstream URL with the right auth header, and that the chosen
 *      model is correctly placed (body for anthropic+openai, URL path
 *      for google).
 *
 * Network is stubbed: globalThis.fetch is replaced so we never actually
 * call api.anthropic.com / api.openai.com / generativelanguage.googleapis.com.
 * The classifier (classifyWithLlmDetailed → Gemini) is mocked so tests
 * are hermetic and deterministic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';

const ENV_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY'];
let _savedEnv;

function saveEnv() {
  _savedEnv = {};
  for (const k of ENV_KEYS) {
    _savedEnv[k] = process.env[k];
    delete process.env[k];
  }
}

function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (_savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = _savedEnv[k];
  }
}

function mockStubResponse({ status = 200, body = 'ok', headers = { 'content-type': 'text/event-stream' } } = {}) {
  return new Response(body, { status, headers });
}

// POST a JSON body to the local loopback server. Resolves with { status,
// headers, body }. Pure node:http — no SDK fluff, mirrors what OC's
// transport-stream does.
function postLoopback({ port, path, body }) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': data.length },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── PR 2 regression: catalog.run awaits server bind ────────────────────

describe('catalog.run() — PR 2 regression net', () => {
  let plugin;
  let startLocalServerSpy;

  beforeEach(async () => {
    vi.resetModules();
    saveEnv();

    // Inject a slow startLocalServer so we can prove catalog.run blocks on
    // it (the failure mode in PR 2 was registration completing while the
    // bind never resolved — hooks "registered" but no traffic ever flowed).
    startLocalServerSpy = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 60));
      return { port: 12345, server: { close: vi.fn() } };
    });
    vi.doMock('../lib/local-server.js', () => ({
      startLocalServer: startLocalServerSpy,
    }));

    const mod = await import('../lib/plugin-core.js');
    plugin = mod.default;
  });

  afterEach(() => {
    restoreEnv();
    vi.doUnmock('../lib/local-server.js');
    vi.restoreAllMocks();
  });

  function makeApi() {
    return {
      config: {},
      pluginConfig: {},
      logger: { info: vi.fn(), warn: vi.fn() },
      registerProvider: vi.fn(),
      registerTool: vi.fn(),
      on: vi.fn(),
    };
  }

  it('catalog.run() does not resolve before startLocalServer resolves', async () => {
    const api = makeApi();
    plugin.register(api);

    const provider = api.registerProvider.mock.calls[0][0];
    const t0 = Date.now();
    const result = await provider.catalog.run({});
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeGreaterThanOrEqual(50); // proves the await happened
    expect(result.provider).toBeDefined();
    expect(startLocalServerSpy).toHaveBeenCalledTimes(1);
  });

  it('catalog.run() returns 3 virtual models — one per lab shape', async () => {
    const api = makeApi();
    plugin.register(api);

    const provider = api.registerProvider.mock.calls[0][0];
    const result = await provider.catalog.run({});

    expect(Array.isArray(result.provider.models)).toBe(true);
    expect(result.provider.models).toHaveLength(3);

    const ids = result.provider.models.map((m) => m.id).sort();
    expect(ids).toEqual(['auto-anthropic', 'auto-google', 'auto-openai']);
  });

  it('each virtual model declares its lab-native OC api string', async () => {
    const api = makeApi();
    plugin.register(api);
    const provider = api.registerProvider.mock.calls[0][0];
    const result = await provider.catalog.run({});

    const byId = Object.fromEntries(result.provider.models.map((m) => [m.id, m]));
    expect(byId['auto-anthropic'].api).toBe('anthropic-messages');
    expect(byId['auto-openai'].api).toBe('openai-responses');
    expect(byId['auto-google'].api).toBe('google-generative-ai');
  });

  it('each virtual model carries a path-prefixed loopback baseUrl with the bound port', async () => {
    const api = makeApi();
    plugin.register(api);
    const provider = api.registerProvider.mock.calls[0][0];
    const result = await provider.catalog.run({});

    const byId = Object.fromEntries(result.provider.models.map((m) => [m.id, m]));
    expect(byId['auto-anthropic'].baseUrl).toBe('http://127.0.0.1:12345/anthropic');
    expect(byId['auto-openai'].baseUrl).toBe('http://127.0.0.1:12345/openai/v1');
    expect(byId['auto-google'].baseUrl).toBe('http://127.0.0.1:12345/google/v1beta');
  });

  it('staticCatalog.run() returns the same shape as catalog.run()', async () => {
    const api = makeApi();
    plugin.register(api);
    const provider = api.registerProvider.mock.calls[0][0];

    const dynamic = await provider.catalog.run({});
    const stat = await provider.staticCatalog.run({});

    expect(stat.provider.models.map((m) => m.id).sort())
      .toEqual(dynamic.provider.models.map((m) => m.id).sort());
  });

  it('auth.run() configPatch advertises all three default models', async () => {
    const api = makeApi();
    plugin.register(api);
    const provider = api.registerProvider.mock.calls[0][0];

    const auth = provider.auth[0];
    const authResult = await auth.run({});

    const defaults = authResult.configPatch?.agents?.defaults?.models || {};
    expect(Object.keys(defaults).sort()).toEqual([
      'robot-resources/auto-anthropic',
      'robot-resources/auto-google',
      'robot-resources/auto-openai',
    ]);
    expect(authResult.defaultModel).toBe('robot-resources/auto-anthropic');
  });
});

// ── Local server dispatch — real loopback, stubbed upstream fetch ──────

describe('local server dispatch — per-shape forwarding', () => {
  let server;
  let port;
  let fetchSpy;
  let startLocalServer;
  let resetKeyCache;

  beforeEach(async () => {
    vi.resetModules();
    saveEnv();

    // Stub the classifier so router decisions are hermetic. The real
    // router picks within the filtered DB; classifier only nudges
    // task-type / complexity. A fixed classifier => deterministic pick.
    vi.doMock('../lib/routing/classify.js', () => ({
      classifyWithLlmDetailed: vi.fn(async () => ({
        result: { taskType: 'general', complexity: 0.3 },
      })),
    }));

    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.OPENAI_API_KEY = 'sk-oai-test';
    process.env.GOOGLE_API_KEY = 'AIza-test';

    fetchSpy = vi.fn(async () => mockStubResponse());
    vi.stubGlobal('fetch', fetchSpy);

    const mod = await import('../lib/local-server.js');
    startLocalServer = mod.startLocalServer;
    const keyMod = await import('../lib/provider-keys.js');
    resetKeyCache = keyMod._resetCache;
    resetKeyCache();

    const result = await startLocalServer({
      api: { logger: { info: vi.fn(), warn: vi.fn() }, config: {} },
      telemetry: { emit: vi.fn() },
      detectedProviders: new Set(['anthropic', 'openai', 'google']),
    });
    server = result.server;
    port = result.port;
  });

  afterEach(async () => {
    if (server) {
      await new Promise((r) => server.close(r));
      server = null;
    }
    if (resetKeyCache) resetKeyCache();
    restoreEnv();
    vi.unstubAllGlobals();
    vi.doUnmock('../lib/routing/classify.js');
    vi.restoreAllMocks();
  });

  it('anthropic shape: forwards to api.anthropic.com/v1/messages with x-api-key', async () => {
    const res = await postLoopback({
      port,
      path: '/anthropic/v1/messages',
      body: {
        model: 'placeholder-anthropic',
        messages: [{ role: 'user', content: 'write a python function' }],
      },
    });

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(opts.method).toBe('POST');
    expect(opts.headers['x-api-key']).toBe('sk-ant-test');
    expect(opts.headers['anthropic-version']).toBe('2023-06-01');
    const sentBody = JSON.parse(opts.body);
    // Classifier picked some real anthropic model; should NOT still be the placeholder.
    expect(sentBody.model).not.toBe('placeholder-anthropic');
  });

  it('openai shape: forwards to api.openai.com/v1/responses with Bearer auth', async () => {
    const res = await postLoopback({
      port,
      path: '/openai/v1/responses',
      body: {
        model: 'placeholder-openai',
        input: 'write a python function',
      },
    });

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(opts.headers['authorization']).toBe('Bearer sk-oai-test');
    const sentBody = JSON.parse(opts.body);
    expect(sentBody.model).not.toBe('placeholder-openai');
  });

  it('google shape: forwards to generativelanguage.googleapis.com with x-goog-api-key, model swapped in URL', async () => {
    const res = await postLoopback({
      port,
      path: '/google/v1beta/models/placeholder-google:streamGenerateContent?alt=sse',
      body: {
        contents: [{ role: 'user', parts: [{ text: 'write a python function' }] }],
      },
    });

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toMatch(/^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/[^:]+:streamGenerateContent/);
    expect(url).not.toContain('placeholder-google');
    expect(url).toContain('alt=sse');
    expect(opts.headers['x-goog-api-key']).toBe('AIza-test');
  });

  it('unknown URL prefix → 404, fetch never called', async () => {
    const res = await postLoopback({
      port,
      path: '/unknown/v1/messages',
      body: { messages: [{ role: 'user', content: 'hi' }] },
    });

    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('non-POST → 405', async () => {
    const result = await new Promise((resolve) => {
      const req = http.request({
        host: '127.0.0.1', port, path: '/anthropic/v1/messages', method: 'GET',
      }, (res) => resolve({ status: res.statusCode }));
      req.end();
    });
    expect(result.status).toBe(405);
  });

  it('invalid JSON body → 400', async () => {
    const result = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, path: '/anthropic/v1/messages', method: 'POST',
        headers: { 'content-type': 'application/json' },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.write('not-json{');
      req.end();
    });
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body).error.type).toBe('invalid_request');
  });
});

// ── Provider-key resolution per shape ──────────────────────────────────

describe('provider-key resolution per shape', () => {
  let server;
  let port;
  let resetKeyCache;

  async function bootServer({ env = {}, detectedProviders } = {}) {
    saveEnv();
    Object.assign(process.env, env);
    vi.stubGlobal('fetch', vi.fn(async () => mockStubResponse()));

    const mod = await import('../lib/local-server.js');
    const keyMod = await import('../lib/provider-keys.js');
    resetKeyCache = keyMod._resetCache;
    resetKeyCache();

    const result = await mod.startLocalServer({
      api: { logger: { info: vi.fn(), warn: vi.fn() }, config: {} },
      telemetry: { emit: vi.fn() },
      detectedProviders: detectedProviders || new Set(['anthropic', 'openai', 'google']),
    });
    server = result.server;
    port = result.port;
  }

  beforeEach(() => {
    vi.resetModules();
    vi.doMock('../lib/routing/classify.js', () => ({
      classifyWithLlmDetailed: vi.fn(async () => ({
        result: { taskType: 'general', complexity: 0.3 },
      })),
    }));
  });

  afterEach(async () => {
    if (server) { await new Promise((r) => server.close(r)); server = null; }
    if (resetKeyCache) resetKeyCache();
    restoreEnv();
    vi.unstubAllGlobals();
    vi.doUnmock('../lib/routing/classify.js');
    vi.restoreAllMocks();
  });

  it('missing anthropic key → 500 with "anthropic" in error', async () => {
    await bootServer({ env: { OPENAI_API_KEY: 'sk', GOOGLE_API_KEY: 'AIza' } });
    const res = await postLoopback({
      port,
      path: '/anthropic/v1/messages',
      body: { messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.status).toBe(500);
    const err = JSON.parse(res.body).error;
    expect(err.type).toBe('auth');
    expect(err.message).toContain('anthropic');
  });

  it('missing openai key → 500 with "openai" in error', async () => {
    await bootServer({ env: { ANTHROPIC_API_KEY: 'sk', GOOGLE_API_KEY: 'AIza' } });
    const res = await postLoopback({
      port,
      path: '/openai/v1/responses',
      body: { input: 'hi' },
    });
    expect(res.status).toBe(500);
    const err = JSON.parse(res.body).error;
    expect(err.type).toBe('auth');
    expect(err.message).toContain('openai');
  });

  it('missing google key → 500 with "google" in error', async () => {
    await bootServer({ env: { ANTHROPIC_API_KEY: 'sk', OPENAI_API_KEY: 'sk' } });
    const res = await postLoopback({
      port,
      path: '/google/v1beta/models/gemini-x:streamGenerateContent',
      body: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
    });
    expect(res.status).toBe(500);
    const err = JSON.parse(res.body).error;
    expect(err.type).toBe('auth');
    expect(err.message).toContain('google');
  });

  it('GEMINI_API_KEY also resolves the google shape (alternate env var)', async () => {
    await bootServer({ env: { GEMINI_API_KEY: 'AIza-gemini-only' } });
    const fetchSpy = globalThis.fetch;
    const res = await postLoopback({
      port,
      path: '/google/v1beta/models/gemini-x:streamGenerateContent',
      body: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
    });
    expect(res.status).toBe(200);
    const [, opts] = fetchSpy.mock.calls[0];
    expect(opts.headers['x-goog-api-key']).toBe('AIza-gemini-only');
  });
});
