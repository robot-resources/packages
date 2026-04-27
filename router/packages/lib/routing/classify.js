import { getClassifierKey, callGemini, parseClassification } from './classifier_client.js';

export const CLASSIFIER_TIMEOUT_MS = 2_000;
export const CLASSIFIER_MAX_PROMPT_LENGTH = 2000;

// Do NOT rephrase — the exact string is calibrated against Gemini's output
// distribution. Changes here invalidate the keyword/slow-path thresholds in
// task_detection.js + selector.js.
export const CLASSIFICATION_PROMPT =
  'Classify this user prompt into a task type and complexity.\n' +
  '\n' +
  'Task types: coding, analysis, reasoning, simple_qa, creative, general\n' +
  'Complexity: 1 (trivial) to 5 (expert-level)\n' +
  '\n' +
  'Examples:\n' +
  '- "Write a Python sort function" -> {"task_type": "coding", "complexity": 2}\n' +
  '- "Explain quantum entanglement" -> {"task_type": "reasoning", "complexity": 3}\n' +
  '- "What is the capital of France?" -> {"task_type": "simple_qa", "complexity": 1}\n' +
  '- "Write a sonnet about the ocean" -> {"task_type": "creative", "complexity": 3}\n' +
  '- "Analyze microservices vs monolith" -> {"task_type": "analysis", "complexity": 4}\n' +
  '- "Build a distributed consensus algorithm" -> {"task_type": "coding", "complexity": 5}\n' +
  '- "Summarize this meeting" -> {"task_type": "general", "complexity": 2}\n' +
  '\n' +
  'Respond with ONLY valid JSON, no other text:\n' +
  '{"task_type": "<type>", "complexity": <1-5>}\n' +
  '\n' +
  'User prompt: ';

class ClassifierError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'ClassifierError';
    this.reason = reason;
  }
}

async function _classifyImpl(prompt) {
  const keyInfo = await getClassifierKey();
  if (keyInfo === null) throw new ClassifierError('no_key');

  if (keyInfo.provider !== 'google') throw new ClassifierError('provider_not_google');

  const truncated = prompt.slice(0, CLASSIFIER_MAX_PROMPT_LENGTH);
  const fullPrompt = CLASSIFICATION_PROMPT + truncated;

  let text;
  try {
    text = await callGemini(keyInfo.model, keyInfo.apiKey, fullPrompt);
  } catch {
    throw new ClassifierError('network_error');
  }

  const parsed = parseClassification(text.trim(), keyInfo.model);
  if (parsed === null) throw new ClassifierError('parse_error');
  return parsed;
}

function _withTimeout(promise, ms) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ClassifierError('timeout')), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

export async function classifyWithLlmDetailed(prompt, opts = {}) {
  const { telemetry } = opts;

  if (!prompt || !prompt.trim()) {
    return { result: null, reason: 'empty_prompt' };
  }

  let result = null;
  let reason = null;
  try {
    result = await _withTimeout(_classifyImpl(prompt), CLASSIFIER_TIMEOUT_MS);
  } catch (err) {
    reason = err instanceof ClassifierError ? err.reason : 'network_error';
  }

  // empty_prompt is a degenerate caller-side case, not an infrastructure
  // issue — don't pollute telemetry with it.
  if (telemetry && reason !== null && reason !== 'empty_prompt') {
    try {
      telemetry.emit('classifier_fallback', { reason });
    } catch { /* never let telemetry errors break routing */ }
  }

  return { result, reason };
}

export async function classifyWithLlm(prompt) {
  return (await classifyWithLlmDetailed(prompt)).result;
}
