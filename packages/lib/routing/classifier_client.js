import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const _DEFAULT_CONFIG_PATH = join(homedir(), '.robot-resources', 'config.json');
const _DEFAULT_PLATFORM_URL = 'https://api.robotresources.ai';

const _ALLOWED_PLATFORM_HOSTS = new Set([
  'api.robotresources.ai',
  'platform.robotresources.ai',
  'localhost',
]);

const _CACHE_TTL_MS = 3_600_000;
const _RETRY_BACKOFF_MS = 60_000;
const _FETCH_TIMEOUT_MS = 5_000;

const _VALID_TASK_TYPES = new Set([
  'coding',
  'analysis',
  'reasoning',
  'simple_qa',
  'creative',
  'general',
]);

function _isAllowedPlatformUrl(url) {
  try {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol)) return false;
    return _ALLOWED_PLATFORM_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

const _state = {
  enabled: false,
  userApiKey: null,
  platformUrl: null,
  cached: null,
  cachedAt: 0,
  lastFailure: 0,
  inflight: null,
};

function _loadConfig(configPath = _DEFAULT_CONFIG_PATH) {
  let raw;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch {
    return;
  }

  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    return;
  }

  const key = config?.api_key ?? '';
  if (!key) return;

  _state.userApiKey = key;
  _state.enabled = true;

  if (_state.platformUrl == null) {
    const candidate = config?.platform_url || _DEFAULT_PLATFORM_URL;
    if (_isAllowedPlatformUrl(candidate)) {
      _state.platformUrl = candidate;
    } else {
      _state.enabled = false;
      _state.userApiKey = null;
    }
  }
}

_loadConfig();

export function _resetForTesting(configPath) {
  _state.enabled = false;
  _state.userApiKey = null;
  _state.platformUrl = null;
  _state.cached = null;
  _state.cachedAt = 0;
  _state.lastFailure = 0;
  _state.inflight = null;
  if (configPath !== undefined) {
    _loadConfig(configPath);
  }
}

export function isEnabled() {
  return _state.enabled;
}

async function _fetchKey() {
  const url = `${_state.platformUrl}/v1/classifier-key`;
  let resp;
  try {
    resp = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${_state.userApiKey}` },
      signal: AbortSignal.timeout(_FETCH_TIMEOUT_MS),
    });
  } catch {
    return null;
  }

  if (resp.status !== 200) return null;

  let body;
  try {
    body = await resp.json();
  } catch {
    return null;
  }

  const data = body?.data ?? {};
  const provider = data.provider;
  const model = data.model;
  const apiKey = data.api_key;

  if (!provider || !model || !apiKey) return null;

  return { provider: String(provider), model: String(model), apiKey: String(apiKey) };
}

export async function getClassifierKey() {
  if (!_state.enabled) return null;

  const now = Date.now();
  if (_state.cached && (now - _state.cachedAt) < _CACHE_TTL_MS) {
    return _state.cached;
  }

  if (_state.inflight) {
    return _state.inflight;
  }

  if (_state.lastFailure > 0 && (now - _state.lastFailure) < _RETRY_BACKOFF_MS) {
    return _state.cached;
  }

  _state.inflight = (async () => {
    try {
      const result = await _fetchKey();
      if (result !== null) {
        _state.cached = result;
        _state.cachedAt = Date.now();
        _state.lastFailure = 0;
        return result;
      }
      _state.lastFailure = Date.now();
      return _state.cached;
    } finally {
      _state.inflight = null;
    }
  })();

  return _state.inflight;
}

export async function callGemini(model, apiKey, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.0, maxOutputTokens: 50 },
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(_FETCH_TIMEOUT_MS),
  });

  if (!resp.ok) {
    const err = new Error(`Gemini HTTP ${resp.status}`);
    err.status = resp.status;
    throw err;
  }

  const data = await resp.json();
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new Error('Gemini response missing parts');
  }
  const text = parts.map((p) => p?.text ?? '').join('');
  return text;
}

export function parseClassification(text, modelName) {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    const newlineIdx = cleaned.indexOf('\n');
    cleaned = newlineIdx === -1 ? cleaned : cleaned.slice(newlineIdx + 1);
    if (cleaned.endsWith('```')) {
      cleaned = cleaned.slice(0, -3).trim();
    }
  }

  let data;
  try {
    data = JSON.parse(cleaned);
  } catch {
    return null;
  }

  const taskType = data?.task_type;
  if (!_VALID_TASK_TYPES.has(taskType)) return null;

  const complexity = data?.complexity;
  if (typeof complexity !== 'number' || Number.isNaN(complexity)) return null;

  const clamped = Math.max(1, Math.min(5, Math.trunc(complexity)));

  return { taskType, complexity: clamped, classifierModel: modelName };
}
