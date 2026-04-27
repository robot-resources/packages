import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const _DB_PATH = join(dirname(fileURLToPath(import.meta.url)), 'models_db.json');

export const IMPLEMENTED_PROVIDERS = new Set(['openai', 'anthropic', 'google']);

export const CAPABILITY_THRESHOLD = 0.70;

export function validateModelsDb(modelsDb) {
  if (!modelsDb || modelsDb.length === 0) return modelsDb;

  const missingProvider = [];
  const invalidProviders = new Map();

  for (const model of modelsDb) {
    const name = model.name ?? '<unnamed>';
    const provider = model.provider;

    if (provider == null) {
      missingProvider.push(name);
      continue;
    }

    if (!IMPLEMENTED_PROVIDERS.has(provider)) {
      if (!invalidProviders.has(provider)) invalidProviders.set(provider, []);
      invalidProviders.get(provider).push(name);
    }
  }

  const errors = [];
  if (missingProvider.length) {
    errors.push(`Models with missing provider field: ${missingProvider.join(', ')}`);
  }
  if (invalidProviders.size) {
    const sortedKeys = [...invalidProviders.keys()].sort();
    const parts = sortedKeys.map((prov) => `${prov} (${invalidProviders.get(prov).join(', ')})`);
    const supported = [...IMPLEMENTED_PROVIDERS].sort().join(', ');
    errors.push(`Unimplemented providers: ${parts.join('; ')}. Supported: ${supported}`);
  }

  if (errors.length) {
    throw new Error(errors.join('; '));
  }

  return modelsDb;
}

export function loadModelsDb() {
  const db = JSON.parse(readFileSync(_DB_PATH, 'utf-8'));
  validateModelsDb(db);
  return db;
}

export const MODELS_DB = loadModelsDb();

export const DEFAULT_BASELINE = MODELS_DB.reduce(
  (max, m) => (m.cost_per_1k_input > max.cost_per_1k_input ? m : max),
  MODELS_DB[0],
).name;

export function getCapableModels(taskType, modelsDb = MODELS_DB, threshold = CAPABILITY_THRESHOLD) {
  const capable = [];
  for (const model of modelsDb) {
    let capability = model.capabilities?.[taskType];
    if (capability == null) {
      capability = model.capabilities?.overall ?? 0;
    }
    if (capability >= threshold) {
      capable.push(model);
    }
  }
  return capable;
}

export function selectCheapestModel(models) {
  if (!models || models.length === 0) return null;
  return models.reduce(
    (min, m) => (m.cost_per_1k_input < min.cost_per_1k_input ? m : min),
    models[0],
  );
}

export function calculateSavings(selectedModel, baselineModel = null, modelsDb = MODELS_DB) {
  let baseline = baselineModel;
  if (baseline == null) {
    baseline = modelsDb.find((m) => m.name === DEFAULT_BASELINE) ?? modelsDb[0];
  }

  const baselineCost = baseline.cost_per_1k_input;
  const selectedCost = selectedModel.cost_per_1k_input;

  const savingsPercent = baselineCost > 0
    ? ((baselineCost - selectedCost) / baselineCost) * 100
    : 0.0;

  return {
    baseline_model: baseline.name,
    selected_model: selectedModel.name,
    baseline_cost: baselineCost,
    selected_cost: selectedCost,
    savings_percent: Math.round(savingsPercent * 10) / 10,
    savings_per_1k_tokens: Math.round((baselineCost - selectedCost) * 1e6) / 1e6,
  };
}

export function rankCapableModels(models) {
  if (!models || models.length === 0) return [];
  return [...models].sort((a, b) => a.cost_per_1k_input - b.cost_per_1k_input);
}

export function getModelByName(name, modelsDb = MODELS_DB) {
  return modelsDb.find((m) => m.name === name) ?? null;
}
