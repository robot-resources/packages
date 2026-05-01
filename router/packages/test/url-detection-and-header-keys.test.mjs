// Tests for the v2.x-derived robustness pair:
//   - detectProviderFromUrl recognizes bare lab-native URLs in addition to
//     the multi-shape prefix path (`/anthropic/...`)
//   - resolveProviderKey reads from request headers FIRST, before falling
//     back to stored config / disk / env
//
// Both restore behavior the python daemon had pre-PR-#173 — and the
// combination is what makes routing survive openclaw.json drift.

import { describe, it, expect, beforeEach } from 'vitest';
import { detectProviderFromUrl, buildUpstreamUrl } from '../lib/upstream.js';
import { resolveProviderKey, _resetCache } from '../lib/provider-keys.js';

describe('detectProviderFromUrl — multi-shape prefix path', () => {
  it('recognizes /anthropic/v1/messages as anthropic', () => {
    expect(detectProviderFromUrl('/anthropic/v1/messages')).toBe('anthropic');
  });

  it('recognizes /openai/v1/responses as openai', () => {
    expect(detectProviderFromUrl('/openai/v1/responses')).toBe('openai');
  });

  it('recognizes /google/v1beta/models/gemini-2.5-flash:generateContent as google', () => {
    expect(detectProviderFromUrl('/google/v1beta/models/gemini-2.5-flash:generateContent')).toBe('google');
  });
});

describe('detectProviderFromUrl — bare lab-native path (the v2.x fallback)', () => {
  // OC dispatches via provider.baseUrl (no shape prefix) when the per-model
  // baseUrl path isn't taken. v3.0.0's permissive endsWith('/messages')
  // matching covered this; the strict-prefix code in v4.3.0 didn't.
  it('recognizes bare /v1/messages as anthropic', () => {
    expect(detectProviderFromUrl('/v1/messages')).toBe('anthropic');
  });

  it('recognizes /messages (no /v1 prefix) as anthropic', () => {
    expect(detectProviderFromUrl('/messages')).toBe('anthropic');
  });

  it('recognizes /v1/responses as openai', () => {
    expect(detectProviderFromUrl('/v1/responses')).toBe('openai');
  });

  it('recognizes /v1/chat/completions as openai (legacy shape)', () => {
    expect(detectProviderFromUrl('/v1/chat/completions')).toBe('openai');
  });

  it('recognizes :generateContent in URL as google', () => {
    expect(detectProviderFromUrl('/v1beta/models/gemini-2.5-flash-lite:generateContent')).toBe('google');
  });

  it('recognizes :streamGenerateContent in URL as google', () => {
    expect(detectProviderFromUrl('/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse')).toBe('google');
  });

  it('strips query string before suffix match', () => {
    expect(detectProviderFromUrl('/v1/messages?stream=true')).toBe('anthropic');
  });
});

describe('detectProviderFromUrl — unrecognized', () => {
  it('returns null for empty url', () => {
    expect(detectProviderFromUrl('')).toBe(null);
    expect(detectProviderFromUrl(null)).toBe(null);
  });

  it('returns null for paths that match no shape', () => {
    expect(detectProviderFromUrl('/random/path')).toBe(null);
    expect(detectProviderFromUrl('/v1/foo')).toBe(null);
  });
});

describe('buildUpstreamUrl — handles both prefixed and bare URLs', () => {
  it('strips the /anthropic prefix when present', () => {
    const url = buildUpstreamUrl({
      provider: 'anthropic',
      inboundUrl: '/anthropic/v1/messages',
    });
    expect(url).toBe('https://api.anthropic.com/v1/messages');
  });

  it('forwards bare /v1/messages without stripping (provider.baseUrl path)', () => {
    const url = buildUpstreamUrl({
      provider: 'anthropic',
      inboundUrl: '/v1/messages',
    });
    expect(url).toBe('https://api.anthropic.com/v1/messages');
  });

  it('strips /openai/v1 prefix when present', () => {
    const url = buildUpstreamUrl({
      provider: 'openai',
      inboundUrl: '/openai/v1/responses',
    });
    expect(url).toBe('https://api.openai.com/v1/responses');
  });

  it('rewrites google model id with prefix', () => {
    const url = buildUpstreamUrl({
      provider: 'google',
      inboundUrl: '/google/v1beta/models/old-model:generateContent?alt=sse',
      chosenModel: 'gemini-2.5-flash-lite',
    });
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?alt=sse');
  });

  it('rewrites google model id without prefix (bare path)', () => {
    const url = buildUpstreamUrl({
      provider: 'google',
      inboundUrl: '/v1beta/models/old-model:streamGenerateContent',
      chosenModel: 'gemini-2.5-flash-lite',
    });
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:streamGenerateContent');
  });
});

describe('resolveProviderKey — reads from request headers first', () => {
  beforeEach(() => {
    _resetCache();
  });

  it('returns the anthropic key from x-api-key header', () => {
    const key = resolveProviderKey({
      provider: 'anthropic',
      requestHeaders: { 'x-api-key': 'sk-ant-real-key-12345' },
    });
    expect(key).toBe('sk-ant-real-key-12345');
  });

  it('returns the openai key from Authorization: Bearer header', () => {
    const key = resolveProviderKey({
      provider: 'openai',
      requestHeaders: { authorization: 'Bearer sk-openai-real-12345' },
    });
    expect(key).toBe('sk-openai-real-12345');
  });

  it('returns the google key from x-goog-api-key header', () => {
    const key = resolveProviderKey({
      provider: 'google',
      requestHeaders: { 'x-goog-api-key': 'AIzaSyReal-google-key-12345' },
    });
    expect(key).toBe('AIzaSyReal-google-key-12345');
  });

  it('header value takes precedence over api.config.models.providers', () => {
    const key = resolveProviderKey({
      provider: 'anthropic',
      requestHeaders: { 'x-api-key': 'sk-ant-from-header-12345' },
      api: { config: { models: { providers: { anthropic: { apiKey: 'sk-ant-from-config-12345' } } } } },
    });
    expect(key).toBe('sk-ant-from-header-12345');
  });

  it('falls back to api.config when header is missing', () => {
    const key = resolveProviderKey({
      provider: 'anthropic',
      api: { config: { models: { providers: { anthropic: { apiKey: 'sk-ant-from-config-12345' } } } } },
    });
    expect(key).toBe('sk-ant-from-config-12345');
  });

  it('rejects placeholder/dummy values from headers (n/a)', () => {
    _resetCache();
    const key = resolveProviderKey({
      provider: 'anthropic',
      requestHeaders: { 'x-api-key': 'n/a' },
      api: { config: { models: { providers: { anthropic: { apiKey: 'sk-ant-from-config-12345' } } } } },
    });
    expect(key).toBe('sk-ant-from-config-12345');
  });

  it('does not cache header-source keys (cache invariant for stored sources)', () => {
    // First call: reads from header (no cache)
    resolveProviderKey({
      provider: 'anthropic',
      requestHeaders: { 'x-api-key': 'sk-ant-request-A' },
    });
    // Second call: different header value, no api stored config — should
    // return the new header value, not a cached one.
    const second = resolveProviderKey({
      provider: 'anthropic',
      requestHeaders: { 'x-api-key': 'sk-ant-request-B' },
    });
    expect(second).toBe('sk-ant-request-B');
  });

  it('returns null when no source has a real key', () => {
    const key = resolveProviderKey({ provider: 'anthropic', requestHeaders: {} });
    expect(key).toBe(null);
  });
});
