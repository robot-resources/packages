/**
 * Locate the user's Anthropic API key for the in-process router.
 *
 * The OC plugin SDK doesn't expose a synchronous "get me the resolved api
 * key for provider X" helper, but the bundled anthropic provider stores its
 * key in the agent's auth-profile store. We read the same files directly.
 *
 * Resolution order (first hit wins, then cached for the process lifetime):
 *   1. api.config.models.providers.anthropic.apiKey  (explicit OC config)
 *   2. ~/.openclaw/agents/<agent>/agent/auth-profiles.json  ('main' first,
 *      then alpha) — pick first profile with provider==='anthropic' and a
 *      key that looks real
 *   3. process.env.ANTHROPIC_API_KEY
 *   4. null  (caller surfaces an error to OC)
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

let _cached = null;

export function resolveAnthropicKey({ api } = {}) {
  if (_cached) return _cached;

  const fromConfig = api?.config?.models?.providers?.anthropic?.apiKey
    ?? api?.config?.models?.providers?.anthropic?.api_key;
  if (looksReal(fromConfig)) { _cached = fromConfig; return _cached; }

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
        if (profile?.provider !== 'anthropic') continue;
        const key = profile?.key ?? profile?.token ?? profile?.apiKey;
        if (looksReal(key)) { _cached = key; return _cached; }
      }
    } catch { /* try next agent */ }
  }

  if (looksReal(process.env.ANTHROPIC_API_KEY)) {
    _cached = process.env.ANTHROPIC_API_KEY;
    return _cached;
  }

  return null;
}

function looksReal(s) {
  return typeof s === 'string'
    && s.length > 5
    && s !== 'n/a'
    && !s.startsWith('${')
    && !s.includes('YOUR_');
}

export function _resetCache() { _cached = null; }
