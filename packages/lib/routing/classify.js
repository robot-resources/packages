import { getClassifierKey, callGemini, parseClassification } from './classifier_client.js';

export const CLASSIFIER_TIMEOUT_MS = 2_000;
export const CLASSIFIER_MAX_PROMPT_LENGTH = 2000;

// Byte-verbatim copy of CLASSIFICATION_PROMPT in
// router/src/robot_resources/routing/classifier.py. Do NOT rephrase — the
// exact string affects Gemini output and is asserted by
// test/routing/classification_prompt.test.mjs.
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

function _sleepNull(ms) {
  return new Promise((resolve) => setTimeout(() => resolve(null), ms));
}

async function _classifyImpl(prompt) {
  const keyInfo = await getClassifierKey();
  if (keyInfo === null) return null;

  // Locked decision: JS classifier supports Google only. If the platform
  // ever serves a non-Google key, fall back to keyword path. See
  // business/refactor-router-in-process.md PR1 risks.
  if (keyInfo.provider !== 'google') return null;

  const truncated = prompt.slice(0, CLASSIFIER_MAX_PROMPT_LENGTH);
  const fullPrompt = CLASSIFICATION_PROMPT + truncated;

  let text;
  try {
    text = await callGemini(keyInfo.model, keyInfo.apiKey, fullPrompt);
  } catch {
    return null;
  }

  return parseClassification(text.trim(), keyInfo.model);
}

export async function classifyWithLlm(prompt) {
  if (!prompt || !prompt.trim()) return null;

  try {
    return await Promise.race([
      _classifyImpl(prompt),
      _sleepNull(CLASSIFIER_TIMEOUT_MS),
    ]);
  } catch {
    return null;
  }
}
