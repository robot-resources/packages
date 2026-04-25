import { analyzePrompt } from './task_detection.js';
import {
  CAPABILITY_THRESHOLD,
  MODELS_DB,
  calculateSavings,
  getCapableModels,
  rankCapableModels,
  selectCheapestModel,
} from './selector.js';
import { classifyWithLlm } from './classify.js';

export const CONFIDENCE_THRESHOLD = 0.85;

export const COMPLEXITY_THRESHOLD_MAP = {
  1: 0.60,
  2: 0.60,
  3: 0.70,
  4: 0.85,
  5: 0.85,
};

// Match Python's f-string default repr for floats: integers render as "X.0".
function _pyFloatStr(v) {
  return Number.isInteger(v) ? v.toFixed(1) : String(v);
}

function _buildResponse({
  taskType,
  selectedModel,
  savings,
  confidence,
  matchedKeywords,
  threshold,
  rankedCandidates,
}) {
  const caps = selectedModel.capabilities ?? {};
  let capability = caps[taskType];
  if (capability == null) capability = caps.overall ?? 0;

  let fallbacks = [];
  if (rankedCandidates && rankedCandidates.length) {
    fallbacks = rankedCandidates
      .filter((m) => m.name !== selectedModel.name)
      .map((m) => ({
        name: m.name,
        provider: m.provider,
        cost_per_1k_input: m.cost_per_1k_input,
      }));
  }

  const reasoning =
    `Selected ${selectedModel.name} (${selectedModel.provider}) ` +
    `as cheapest model capable of '${taskType}' tasks ` +
    `(capability: ${capability.toFixed(2)}, threshold: ${_pyFloatStr(threshold)}). ` +
    `Saves ${_pyFloatStr(savings.savings_percent)}% vs ${savings.baseline_model}.`;

  return {
    selected_model: selectedModel.name,
    provider: selectedModel.provider,
    cost_per_1k_input: selectedModel.cost_per_1k_input,
    cost_per_1k_output: selectedModel.cost_per_1k_output,
    baseline_model: savings.baseline_model,
    baseline_cost: savings.baseline_cost,
    savings_percent: savings.savings_percent,
    task_type: taskType,
    capability_score: Math.round(capability * 100) / 100,
    detection_confidence: confidence,
    reasoning,
    matched_keywords: matchedKeywords,
    max_tokens: selectedModel.max_tokens ?? null,
    ranked_candidates: fallbacks,
  };
}

export function routePrompt(prompt, opts = {}) {
  const db = opts.modelsDb ?? MODELS_DB;
  const threshold = opts.threshold ?? CAPABILITY_THRESHOLD;
  const baselineModel = opts.baselineModel ?? null;

  const analysis = analyzePrompt(prompt);
  let taskType = analysis.task_type;
  const confidence = analysis.confidence;
  const matchedKeywords = analysis.matched_keywords;

  let capable = getCapableModels(taskType, db, threshold);
  if (capable.length === 0) capable = getCapableModels(taskType, db, 0.5);
  if (capable.length === 0) {
    capable = db;
    taskType = 'general';
  }

  let selected = selectCheapestModel(capable);
  if (selected == null) selected = db[0];

  const ranked = rankCapableModels(capable);
  const savings = calculateSavings(selected, baselineModel, db);

  return _buildResponse({
    taskType,
    selectedModel: selected,
    savings,
    confidence,
    matchedKeywords,
    threshold,
    rankedCandidates: ranked,
  });
}

export async function asyncRoutePrompt(prompt, opts = {}) {
  const db = opts.modelsDb ?? MODELS_DB;
  const threshold = opts.threshold ?? CAPABILITY_THRESHOLD;
  const baselineModel = opts.baselineModel ?? null;
  // Test seam: opts.classifierImpl overrides the classifier call.
  const classifier = opts.classifierImpl ?? classifyWithLlm;

  const analysis = analyzePrompt(prompt);
  const keywordTaskType = analysis.task_type;
  const confidence = analysis.confidence;
  const matchedKeywords = analysis.matched_keywords;

  let classificationSource = 'keyword';
  let taskType = keywordTaskType;
  let effectiveThreshold = threshold;
  let clfResult = null;

  if (confidence < CONFIDENCE_THRESHOLD) {
    try {
      clfResult = await classifier(prompt);
    } catch {
      clfResult = null;
    }

    if (clfResult != null && clfResult.taskType !== keywordTaskType) {
      taskType = clfResult.taskType;
      classificationSource = 'llm';
      effectiveThreshold = COMPLEXITY_THRESHOLD_MAP[clfResult.complexity] ?? threshold;
    } else if (clfResult != null && clfResult.taskType === keywordTaskType) {
      effectiveThreshold = COMPLEXITY_THRESHOLD_MAP[clfResult.complexity] ?? threshold;
    }
  }

  let capable = getCapableModels(taskType, db, effectiveThreshold);
  if (capable.length === 0) capable = getCapableModels(taskType, db, 0.5);
  if (capable.length === 0) {
    capable = db;
    taskType = 'general';
  }

  let selected = selectCheapestModel(capable);
  if (selected == null) selected = db[0];

  const ranked = rankCapableModels(capable);
  const savings = calculateSavings(selected, baselineModel, db);

  const result = _buildResponse({
    taskType,
    selectedModel: selected,
    savings,
    confidence,
    matchedKeywords,
    threshold: effectiveThreshold,
    rankedCandidates: ranked,
  });
  result.classification_source = classificationSource;
  result.keyword_task_type = keywordTaskType;
  result.keyword_confidence = confidence;
  result.llm_task_type = clfResult?.taskType ?? null;
  result.llm_complexity = clfResult?.complexity ?? null;
  result.llm_model = clfResult?.classifierModel ?? null;
  result.capability_threshold = effectiveThreshold;
  return result;
}
