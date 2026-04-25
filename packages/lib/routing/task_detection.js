export const TASK_PATTERNS = {
  coding: [
    'write code',
    'write a function',
    'write a script',
    'write a program',
    'write python',
    'write javascript',
    'write typescript',
    'write java',
    'write in python',
    'write in javascript',
    'write in java',
    'python code',
    'javascript code',
    'typescript code',
    'fix the bug',
    'fix this bug',
    'debug this',
    'implement a',
    'implement the',
    'unit test',
    'integration test',
    'rest api',
    'api endpoint',
    'build a',
    'build an',
    'code',
    'function',
    'implement',
    'debug',
    'script',
    'program',
    'algorithm',
    'class',
    'method',
    'bug',
    'syntax',
    'compile',
    'refactor',
    'build',
    'python',
    'javascript',
    'typescript',
    'java',
    'rust',
    'go',
    'golang',
    'sql',
    'html',
    'css',
    'react',
    'vue',
    'angular',
    'nodejs',
    'django',
    'flask',
    'git',
    'docker',
    'kubernetes',
    'database',
    'regex',
    'websocket',
    'parse',
    'serialize',
    'deserialize',
  ],
  reasoning: [
    'explain why',
    'tell me why',
    'reason through',
    'think through',
    'step by step',
    'analyze the logic',
    'evaluate the argument',
    'problem solving',
    'critical thinking',
    'assess the validity',
    'why',
    'explain',
    'reason',
    'deduce',
    'prove',
    'logic',
    'logical',
    'therefore',
    'premise',
    'conclusion',
    'implies',
    'derive',
    'infer',
    'reasoning',
    'puzzle',
    'riddle',
    'paradox',
    'dilemma',
  ],
  analysis: [
    'pros and cons',
    'strengths and weaknesses',
    'compare and contrast',
    'analyze',
    'analyse',
    'examine',
    'evaluate',
    'assess',
    'review',
    'compare',
    'contrast',
    'breakdown',
    'dissect',
    'investigate',
    'research',
    'explore',
    'survey',
    'audit',
    'inspect',
    'scrutinize',
    'advantages',
    'disadvantages',
    'tradeoffs',
    'trade-offs',
    'swot',
    'metrics',
    'kpi',
    'benchmark',
    'trend',
    'insight',
  ],
  simple_qa: [
    'what is',
    "what's",
    'who is',
    "who's",
    'where is',
    "where's",
    'when is',
    "when's",
    'how many',
    'how much',
    'how old',
    'how long',
    'what are',
    'who are',
    'where are',
    'when are',
    'give me',
    'tell me',
    'can you tell',
    'do you know',
    'true or false',
    'yes or no',
    'capital of',
    'population of',
    'price of',
    'cost of',
    'date of',
    'name of',
    'who invented',
    'who founded',
    'who created',
    'when was',
    'what does',
    'stand for',
    'does stand for',
    'define',
    'definition',
    'meaning',
    'translate',
    'convert',
    'calculate',
    'list',
    'weather',
    'temperature',
    'distance',
  ],
  creative: [
    'write a story',
    'write a poem',
    'write an essay',
    'write a blog',
    'write a song',
    'write lyrics',
    'short story',
    'creative writing',
    'come up with',
    'think of ideas',
    'marketing copy',
    'write',
    'create',
    'generate',
    'compose',
    'draft',
    'story',
    'poem',
    'essay',
    'article',
    'blog',
    'content',
    'script',
    'dialogue',
    'narrative',
    'fiction',
    'novel',
    'brainstorm',
    'ideate',
    'imagine',
    'slogan',
    'tagline',
    'headline',
    'brand',
    'marketing',
    'advertisement',
    'campaign',
    'pitch',
    'proposal',
    'song',
    'lyrics',
    'haiku',
    'sonnet',
  ],
};

export const TASK_PRIORITY = ['coding', 'creative', 'reasoning', 'analysis', 'simple_qa'];

// Array preserves Python dict insertion order; first context match wins.
export const CONTEXT_OVERRIDES = [
  {
    trigger: 'why',
    override: 'simple_qa',
    contextWords: ['capital', 'population', 'color', 'name', 'country', 'city', 'president', 'currency', 'language', 'flag'],
  },
  {
    trigger: 'why',
    override: 'coding',
    contextWords: ['error', 'bug', 'crash', 'exception', 'fail', 'failed', 'failing', 'broken', 'not working', "doesn't work", "won't compile"],
  },
  {
    trigger: 'explain',
    override: 'coding',
    contextWords: ['code', 'function', 'async', 'await', 'class', 'method', 'algorithm', 'syntax', 'compile', 'runtime', 'api', 'endpoint'],
  },
  {
    trigger: 'write',
    override: 'coding',
    contextWords: ['function', 'code', 'script', 'api', 'program', 'class', 'method', 'algorithm', 'parser', 'query', 'regex'],
  },
  {
    trigger: 'write',
    override: 'creative',
    contextWords: ['story', 'poem', 'essay', 'article', 'blog', 'song', 'lyrics', 'narrative', 'fiction', 'haiku', 'sonnet'],
  },
  {
    trigger: 'create',
    override: 'coding',
    contextWords: ['function', 'code', 'script', 'api', 'program', 'class', 'method', 'algorithm', 'microservice', 'service', 'endpoint', 'database'],
  },
  {
    trigger: 'compare',
    override: 'analysis',
    contextWords: ['vs', 'versus', 'vs.', 'compared to', 'or', 'better'],
  },
  {
    trigger: 'review',
    override: 'analysis',
    contextWords: ['quality', 'efficiency', 'performance', 'pros', 'cons', 'strengths', 'weaknesses'],
  },
  {
    trigger: 'evaluate',
    override: 'analysis',
    contextWords: ['efficiency', 'performance', 'quality', 'effectiveness', 'pros', 'cons'],
  },
];

const _DEFINITION_PATTERNS = [
  'what is ',
  "what's ",
  'what are ',
  'what does ',
  'what do ',
  'who is ',
  "who's ",
  'who are ',
  'who invented ',
  'who founded ',
  'who created ',
  'when is ',
  "when's ",
  'when was ',
  'when were ',
  'where is ',
  "where's ",
  'where are ',
];

const _FACTUAL_KEYWORDS = [
  'capital',
  'population',
  'color',
  'name',
  'country',
  'city',
  'president',
  'currency',
  'language',
  'flag',
  'temperature',
  'distance',
  'price',
  'cost',
  'date',
];

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isWordMatch(keyword, text) {
  if (keyword.includes(' ')) {
    return text.includes(keyword);
  }
  const pattern = new RegExp('\\b' + escapeRegex(keyword) + '\\b');
  return pattern.test(text);
}

export function analyzePromptStructure(prompt) {
  const words = prompt.split(/\s+/).filter(Boolean);
  const lines = prompt.trim().split('\n');

  const hasCodeBlock = prompt.includes('```');
  const hasInlineCode = prompt.includes('`') && !hasCodeBlock;
  const hasQuestionMark = prompt.includes('?');

  return {
    word_count: words.length,
    has_question_mark: hasQuestionMark,
    has_code_block: hasCodeBlock,
    has_inline_code: hasInlineCode,
    is_short_question: words.length < 10 && hasQuestionMark,
    line_count: lines.length,
  };
}

export function detectTaskType(prompt) {
  const promptLower = prompt.toLowerCase();
  const structure = analyzePromptStructure(prompt);
  const wordCount = structure.word_count;

  if (wordCount < 8) {
    for (const pattern of _DEFINITION_PATTERNS) {
      if (promptLower.startsWith(pattern)) {
        return 'simple_qa';
      }
    }
  }

  if (promptLower.includes('stand for') && wordCount < 10) {
    return 'simple_qa';
  }

  let initialTask = null;
  for (const taskType of TASK_PRIORITY) {
    const keywords = TASK_PATTERNS[taskType];
    if (keywords.some((kw) => isWordMatch(kw, promptLower))) {
      initialTask = taskType;
      break;
    }
  }

  if (initialTask === null) {
    return 'general';
  }

  for (const { trigger, override, contextWords } of CONTEXT_OVERRIDES) {
    if (isWordMatch(trigger, promptLower)) {
      if (contextWords.some((ctx) => isWordMatch(ctx, promptLower))) {
        initialTask = override;
        break;
      }
    }
  }

  const isSimpleQuestion =
    structure.is_short_question && !structure.has_code_block && !structure.has_inline_code;

  if (isSimpleQuestion && initialTask === 'reasoning') {
    const hasFactual = _FACTUAL_KEYWORDS.some((kw) => isWordMatch(kw, promptLower));
    if (hasFactual) {
      initialTask = 'simple_qa';
    }
  }

  if (structure.has_code_block && initialTask !== 'coding') {
    initialTask = 'coding';
  }

  if (structure.line_count > 5 && initialTask === 'simple_qa') {
    initialTask = 'general';
  }

  return initialTask;
}

export function getTaskConfidence(prompt, taskType) {
  if (taskType === 'general') {
    return 0.5;
  }

  const promptLower = prompt.toLowerCase();
  const keywords = TASK_PATTERNS[taskType] ?? [];

  let matches = 0;
  for (const kw of keywords) {
    if (isWordMatch(kw, promptLower)) matches += 1;
  }

  const confidence = Math.min(0.7 + (matches - 1) * 0.1, 0.95);
  return Math.round(confidence * 100) / 100;
}

export function analyzePrompt(prompt) {
  const taskType = detectTaskType(prompt);
  const confidence = getTaskConfidence(prompt, taskType);

  const promptLower = prompt.toLowerCase();
  const keywords = TASK_PATTERNS[taskType] ?? [];
  const matched = keywords.filter((kw) => isWordMatch(kw, promptLower));

  return {
    task_type: taskType,
    confidence,
    matched_keywords: matched.slice(0, 5),
  };
}
