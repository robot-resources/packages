import { MODELS_DB, getModelByName } from './selector.js';

export function getCostPer1kInput(modelName, modelsDb = MODELS_DB) {
  const model = getModelByName(modelName, modelsDb);
  return model ? model.cost_per_1k_input : null;
}

export function getCostPer1kOutput(modelName, modelsDb = MODELS_DB) {
  const model = getModelByName(modelName, modelsDb);
  return model ? model.cost_per_1k_output : null;
}
