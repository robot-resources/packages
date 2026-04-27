#!/usr/bin/env node
// Daily pricing sync: pulls cost + max_tokens from litellm, leaves
// capabilities/provider/name/elo_source untouched (those stay manually
// curated). Workflow at .github/workflows/update-pricing.yml runs this
// daily and opens a PR if models_db.json changed.
//
// Stdout contract (consumed by the workflow):
//   - prints "no changes" when nothing changed (workflow uses this to
//     skip PR creation)
//   - prints lines containing "new_models" or "deprecated_models" so
//     the workflow can surface them in the PR body
//
// Replaces router/src/robot_resources/routing/pricing_updater.py
// (deleted in PR 3 commit 1).

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'lib', 'routing', 'models_db.json');
const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const PRECISION = 6;

// Litellm keys some models under a provider-prefixed name. Only Gemini
// needs the prefix today; OpenAI + Anthropic keys match our names.
const LITELLM_KEY_OVERRIDES = {
  'gemini-2.5-pro': ['gemini/gemini-2.5-pro', 'gemini-2.5-pro'],
  'gemini-2.5-flash': ['gemini/gemini-2.5-flash', 'gemini-2.5-flash'],
  'gemini-2.5-flash-lite': ['gemini/gemini-2.5-flash-lite', 'gemini-2.5-flash-lite'],
};

// litellm_provider → our provider field
const PROVIDER_MAP = {
  openai: 'openai',
  anthropic: 'anthropic',
  vertex_ai: 'google',
  gemini: 'google',
};

const round6 = (n) => Math.round(n * 10 ** PRECISION) / 10 ** PRECISION;

function resolveLitellmKey(modelName, litellm) {
  const candidates = LITELLM_KEY_OVERRIDES[modelName] ?? [modelName];
  for (const c of candidates) if (c in litellm) return c;
  return null;
}

function extractPricing(entry) {
  // Skip non-chat entries (embeddings, image-gen, etc.).
  if (entry.mode != null && entry.mode !== 'chat') {
    return { cost_per_1k_input: null, cost_per_1k_output: null, max_tokens: null };
  }
  const inTok = entry.input_cost_per_token;
  const outTok = entry.output_cost_per_token;
  const maxIn = entry.max_input_tokens;
  return {
    cost_per_1k_input: inTok != null ? round6(inTok * 1000) : null,
    cost_per_1k_output: outTok != null ? round6(outTok * 1000) : null,
    max_tokens: maxIn != null ? Math.trunc(maxIn) : null,
  };
}

async function fetchLitellm() {
  const res = await fetch(LITELLM_URL, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching litellm pricing`);
  const data = await res.json();
  if (typeof data !== 'object' || data === null) throw new Error('litellm response not an object');
  return data;
}

function mergePricing(modelsDb, litellm) {
  const today = new Date().toISOString().slice(0, 10);
  const changes = [];
  const skipped = [];
  for (const model of modelsDb) {
    const key = resolveLitellmKey(model.name, litellm);
    if (key == null) {
      skipped.push(model.name);
      continue;
    }
    const newVals = extractPricing(litellm[key]);
    let changed = false;
    for (const field of ['cost_per_1k_input', 'cost_per_1k_output', 'max_tokens']) {
      const v = newVals[field];
      if (v == null) continue;
      const oldRounded = model[field] != null ? round6(Number(model[field])) : null;
      const newRounded = round6(Number(v));
      if (oldRounded === newRounded) continue;
      changes.push({ name: model.name, field, oldVal: model[field], newVal: v });
      model[field] = v;
      changed = true;
    }
    if (changed) model.last_updated = today;
  }
  return { changes, skipped };
}

function detectNewModels(modelsDb, litellm) {
  const existing = new Set(modelsDb.map((m) => m.name));
  const newOnes = [];
  for (const [key, entry] of Object.entries(litellm)) {
    if (typeof entry !== 'object' || entry === null) continue;
    if (entry.mode != null && entry.mode !== 'chat') continue;
    const ourProvider = PROVIDER_MAP[entry.litellm_provider];
    if (!ourProvider) continue;
    const modelName = key.includes('/') ? key.split('/').slice(1).join('/') : key;
    if (existing.has(modelName)) continue;
    // Skip variants of existing models (date-stamped, preview, etc.).
    const isVariant = [...existing].some(
      (e) => modelName.startsWith(`${e}-`) || modelName.startsWith(`${e}:`),
    );
    if (isVariant) continue;
    const p = extractPricing(entry);
    if (p.cost_per_1k_input == null || p.cost_per_1k_output == null) continue;
    newOnes.push({ name: modelName, provider: ourProvider, litellmKey: key });
  }
  return newOnes;
}

function detectDeprecated(modelsDb, litellm) {
  return modelsDb.filter((m) => resolveLitellmKey(m.name, litellm) == null).map((m) => m.name);
}

function writeAtomic(modelsDb) {
  const tmp = `${DB_PATH}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(modelsDb, null, 2) + '\n', 'utf-8');
  renameSync(tmp, DB_PATH);
}

const litellm = await fetchLitellm();
const modelsDb = JSON.parse(readFileSync(DB_PATH, 'utf-8'));

const { changes, skipped } = mergePricing(modelsDb, litellm);
const newModels = detectNewModels(modelsDb, litellm);
const deprecated = detectDeprecated(modelsDb, litellm);

if (changes.length === 0) {
  console.log('no changes');
} else {
  console.log(`Updated ${changes.length} pricing field(s) across ${new Set(changes.map((c) => c.name)).size} model(s):`);
  for (const c of changes) {
    console.log(`  ${c.name}.${c.field}: ${c.oldVal} -> ${c.newVal}`);
  }
  writeAtomic(modelsDb);
}

if (skipped.length > 0) {
  console.log(`Skipped (not in litellm): ${skipped.join(', ')}`);
}

if (newModels.length > 0) {
  console.log(`new_models (${newModels.length}):`);
  for (const m of newModels) console.log(`  NEW ${m.provider}/${m.name} (litellm key: ${m.litellmKey})`);
}

if (deprecated.length > 0) {
  console.log(`deprecated_models (${deprecated.length}):`);
  for (const name of deprecated) console.log(`  DEPRECATED ${name}`);
}
