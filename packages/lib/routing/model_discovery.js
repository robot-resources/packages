import { createHash } from 'node:crypto';

const _SUPPORTED_PROVIDERS = new Set(['openai', 'anthropic', 'google']);

const _DISCOVERY_TIMEOUT_MS = 15_000;
const _CACHE_TTL_MS = 3_600_000; // 1 hour

// {`${provider}|${keyHash}`: {models: Set<string>, ts: number}}
const _cache = new Map();

function _keyHash(apiKey) {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
}

function _cacheKey(provider, apiKey) {
  return `${provider}|${_keyHash(apiKey)}`;
}

function _isCacheValid(entry) {
  return (Date.now() - entry.ts) < _CACHE_TTL_MS;
}

async function _fetchJson(url, init) {
  const resp = await fetch(url, { ...init, signal: AbortSignal.timeout(_DISCOVERY_TIMEOUT_MS) });
  if (!resp.ok) {
    const err = new Error(`HTTP ${resp.status}`);
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

async function _discoverOpenai(apiKey) {
  const data = await _fetchJson('https://api.openai.com/v1/models', {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
  });
  const models = new Set();
  for (const m of data?.data ?? []) {
    if (m?.id) models.add(m.id);
  }
  return models;
}

async function _discoverAnthropic(apiKey) {
  const models = new Set();
  let afterId = null;

  while (true) {
    const params = new URLSearchParams({ limit: '100' });
    if (afterId) params.set('after_id', afterId);
    const url = `https://api.anthropic.com/v1/models?${params.toString()}`;
    const data = await _fetchJson(url, {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
    });

    for (const m of data?.data ?? []) {
      if (m?.id) models.add(m.id);
    }

    if (!data?.has_more) break;
    const lastId = data?.last_id;
    if (!lastId) break;
    afterId = lastId;
  }

  return models;
}

async function _discoverGoogle(apiKey) {
  const models = new Set();
  let pageToken = null;

  while (true) {
    const params = new URLSearchParams({ key: apiKey, pageSize: '100' });
    if (pageToken) params.set('pageToken', pageToken);
    const url = `https://generativelanguage.googleapis.com/v1beta/models?${params.toString()}`;
    const data = await _fetchJson(url, {
      method: 'GET',
      headers: { 'content-type': 'application/json' },
    });

    for (const m of data?.models ?? []) {
      let name = m?.name ?? '';
      if (name.startsWith('models/')) {
        name = name.slice('models/'.length);
      }
      if (name) models.add(name);
    }

    pageToken = data?.nextPageToken;
    if (!pageToken) break;
  }

  return models;
}

export async function discoverAccessibleModels(provider, apiKey) {
  if (apiKey == null) return null;
  if (!_SUPPORTED_PROVIDERS.has(provider)) return null;

  const ck = _cacheKey(provider, apiKey);
  const cached = _cache.get(ck);
  if (cached && _isCacheValid(cached)) {
    return cached.models;
  }

  let models;
  try {
    if (provider === 'openai') models = await _discoverOpenai(apiKey);
    else if (provider === 'anthropic') models = await _discoverAnthropic(apiKey);
    else if (provider === 'google') models = await _discoverGoogle(apiKey);
    else return null;
  } catch {
    return null;
  }

  _cache.set(ck, { models, ts: Date.now() });
  return models;
}

export function _resetCacheForTesting() {
  _cache.clear();
}
