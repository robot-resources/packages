/**
 * Locate the user's API key for a given LLM provider.
 *
 * The OC plugin SDK doesn't expose a synchronous "get me the resolved api
 * key for provider X" helper, but the bundled providers store their keys
 * in the agent's auth-profile store. We read the same files directly.
 *
 * Resolution order per provider (first hit wins, then cached for the
 * process lifetime — keyed by provider so an Anthropic miss doesn't
 * poison the OpenAI lookup):
 *   1. api.config.models.providers.<provider>.apiKey  (explicit OC config)
 *   2. ~/.openclaw/agents/<agent>/agent/auth-profiles.json  ('main' first,
 *      then alpha) — pick first profile with provider matching and a key
 *      that looks real
 *   3. process.env.<PROVIDER>_API_KEY  (and GEMINI_API_KEY for google)
 *   4. null  (caller surfaces an error to OC)
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const _cache = new Map();

const ENV_VARS = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  google: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
};

export function resolveProviderKey({ api, provider } = {}) {
  if (!provider) return null;
  if (_cache.has(provider)) return _cache.get(provider);

  const fromConfig = api?.config?.models?.providers?.[provider]?.apiKey
    ?? api?.config?.models?.providers?.[provider]?.api_key;
  if (looksReal(fromConfig)) { _cache.set(provider, fromConfig); return fromConfig; }

  const agentsDir = join(homedir(), '.openclaw', 'agents');
  let agents = [];
  try { agents = readdirSync(agentsDir); } catch { /* no agents dir */ }
  agents.sort((a, b) => (a === 'main' ? -1 : b === 'main' ? 1 : a.localeCompare(b)));

  for (const agentId of agents) {
    const profilesPath = join(agentsDir, agentId, 'agent', 'auth-profiles.json');
    try {
      const json = JSON.parse(readFileSync(profilesPath, 'utf-8'));
      const profiles = json?.profiles || {};
      for (const profile of Object.values(profiles)) {
        if (profile?.provider !== provider) continue;
        const key = profile?.key ?? profile?.token ?? profile?.apiKey;
        if (looksReal(key)) { _cache.set(provider, key); return key; }
      }
    } catch { /* try next agent */ }
  }

  for (const envVar of ENV_VARS[provider] || []) {
    if (looksReal(process.env[envVar])) {
      const v = process.env[envVar];
      _cache.set(provider, v);
      return v;
    }
  }

  return null;
}

// Back-compat shim. Existing imports of resolveAnthropicKey continue to work.
export function resolveAnthropicKey({ api } = {}) {
  return resolveProviderKey({ api, provider: 'anthropic' });
}

function looksReal(s) {
  return typeof s === 'string'
    && s.length > 5
    && s !== 'n/a'
    && !s.startsWith('${')
    && !s.includes('YOUR_');
}

export function _resetCache() { _cache.clear(); }
