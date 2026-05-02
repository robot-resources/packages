import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stripJson5 } from './json5.js';

/**
 * Check if OpenClaw is installed.
 */
export function isOpenClawInstalled() {
  const home = homedir();
  return existsSync(join(home, '.openclaw')) || existsSync(join(home, 'openclaw.json'));
}

/**
 * Check if the Robot Resources OpenClaw plugin is already installed.
 */
export function isOpenClawPluginInstalled() {
  const home = homedir();
  const extDir = join(home, '.openclaw', 'extensions');
  return existsSync(join(extDir, 'openclaw-plugin'))
    || existsSync(join(extDir, 'robot-resources-router'));
}

/**
 * Check if the Robot Resources scraper OC plugin is already installed.
 */
export function isScraperOcPluginInstalled() {
  const home = homedir();
  const extDir = join(home, '.openclaw', 'extensions');
  return existsSync(join(extDir, 'robot-resources-scraper-oc-plugin'));
}

/**
 * Detect OpenClaw auth mode: 'subscription' (OAuth token) or 'apikey'.
 *
 * Subscription users authenticate via Anthropic OAuth tokens.
 * Anthropic rejects these tokens from third-party clients, so the
 * only viable routing path is the OpenClaw plugin (not HTTP proxy).
 *
 * Detection order:
 * 1. ANTHROPIC_AUTH_TOKEN env var → subscription
 * 2. openclaw.json config:
 *    a. auth.type === 'oauth' | 'subscription' → subscription
 *    b. auth.profiles.*.mode === 'token' → subscription
 *    c. gateway.auth.mode === 'token' → subscription
 *    d. providers.anthropic.authToken → subscription
 *    e. providers.anthropic.apiKey → apikey
 * 3. Default → apikey (conservative — proxy works fine)
 */
export function getOpenClawAuthMode() {
  // Env var is the strongest signal
  if (process.env.ANTHROPIC_AUTH_TOKEN) return 'subscription';
  if (process.env.ANTHROPIC_API_KEY) return 'apikey';

  // Try reading openclaw.json
  const home = homedir();
  const candidates = [
    join(home, '.openclaw', 'openclaw.json'),
    join(home, 'openclaw.json'),
  ];

  for (const configPath of candidates) {
    if (!existsSync(configPath)) continue;

    try {
      const raw = readFileSync(configPath, 'utf-8');
      const config = JSON.parse(stripJson5(raw));

      // Check explicit auth type
      if (config.auth?.type === 'oauth' || config.auth?.type === 'subscription') {
        return 'subscription';
      }

      // Check auth profiles (real OC config: auth.profiles["anthropic:default"].mode)
      const profiles = config.auth?.profiles;
      if (profiles && typeof profiles === 'object') {
        for (const profile of Object.values(profiles)) {
          if (profile?.mode === 'token') return 'subscription';
        }
      }

      // Check gateway auth mode
      if (config.gateway?.auth?.mode === 'token') return 'subscription';

      // Check for authToken in providers
      const anthropic = config.models?.providers?.anthropic
        || config.providers?.anthropic;
      if (anthropic?.authToken) return 'subscription';
      if (anthropic?.apiKey) return 'apikey';
    } catch {
      // Config unreadable — fall through
    }
  }

  return 'apikey';
}

/**
 * Detect if the environment is headless (no browser available).
 * On headless servers, login() tries xdg-open which fails silently,
 * then hangs for 120s waiting for a callback that never comes.
 */
export function isHeadless() {
  // SSH session — no local browser
  if (process.env.SSH_CONNECTION || process.env.SSH_CLIENT) return true;
  // Linux without a display server
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return true;
  // Docker / container
  if (process.env.container || process.env.DOCKER_CONTAINER) return true;
  return false;
}

/**
 * Check if Claude Code is installed.
 * Looks for ~/.claude/ directory which Claude Code creates on first run.
 */
export function isClaudeCodeInstalled() {
  return existsSync(join(homedir(), '.claude'));
}

/**
 * Check if Cursor is installed.
 * Looks for ~/.cursor/ directory which Cursor creates on first run.
 */
export function isCursorInstalled() {
  return existsSync(join(homedir(), '.cursor'));
}

// ── Agent-runtime detection (Phase 3) ─────────────────────────────────────
//
// Used by the non-OC wizard to pick which shim to install: a NODE_OPTIONS
// shell line for Node agents, or `pip install robot-resources` for Python.
// Returns { kind: 'node'|'python'|null, evidence: string[] } so the wizard
// can show the user WHY we picked a path (debuggable + builds trust).
//
// "Evidence" is the dep markers we found, in priority order. Empty string
// means a generic project (e.g. just package.json, no LLM SDK deps yet) —
// still picks the language but with low confidence.

const NODE_AGENT_DEPS = [
  '@anthropic-ai/sdk',
  'openai',
  '@google/generative-ai',
  '@google-ai/generativelanguage',
  'langchain',
  '@langchain/core',
  '@langchain/anthropic',
  '@langchain/openai',
  '@langchain/google-genai',
  '@langchain/langgraph',
  '@mastra/core',
  'crewai-js',
  'llamaindex',
  'ai', // Vercel AI SDK
];

const PYTHON_AGENT_DEPS = [
  'anthropic',
  'openai',
  'google-generativeai',
  'langchain',
  'langchain-anthropic',
  'langchain-openai',
  'langchain-google-genai',
  'langgraph',
  'crewai',
  'llama-index',
  'llama_index',
];

/**
 * Inspect cwd for evidence of a Node agent project. Returns null if no
 * package.json, or `{ evidence: [...] }` describing matched dep markers
 * (empty list means "Node project but no LLM-SDK deps detected" — generic).
 */
export function detectNodeAgent(cwd = process.cwd()) {
  const pkgPath = join(cwd, 'package.json');
  if (!existsSync(pkgPath)) return null;

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const allDeps = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
      ...(pkg.peerDependencies ?? {}),
    };
    const evidence = NODE_AGENT_DEPS.filter(
      (d) => Object.prototype.hasOwnProperty.call(allDeps, d),
    );
    return { evidence };
  } catch {
    // package.json unreadable but exists — call it Node, no evidence
    return { evidence: [] };
  }
}

/**
 * Inspect cwd for evidence of a Python agent project. Looks at
 * requirements.txt + pyproject.toml. Returns null if neither exists, or
 * `{ evidence: [...] }`. Empty evidence still resolves to Python — many
 * agent projects use ad-hoc deps not in our markers list.
 */
export function detectPythonAgent(cwd = process.cwd()) {
  const reqPath = join(cwd, 'requirements.txt');
  const pyProjPath = join(cwd, 'pyproject.toml');
  const hasReq = existsSync(reqPath);
  const hasPy = existsSync(pyProjPath);
  if (!hasReq && !hasPy) return null;

  const text = [
    hasReq ? safeRead(reqPath) : '',
    hasPy ? safeRead(pyProjPath) : '',
  ].join('\n').toLowerCase();

  const evidence = PYTHON_AGENT_DEPS.filter((d) => {
    // Match `dep`, `dep==`, `dep>=`, `dep[extras]`, or `"dep"`/`'dep'` in
    // pyproject's dependencies array. Word-boundary on the left, anything
    // version-ish on the right.
    const escaped = d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|[\\s"'\\[])${escaped}(\\s|[<>=!~\\["',]|$)`, 'm');
    return re.test(text);
  });

  return { evidence };
}

function safeRead(path) {
  try { return readFileSync(path, 'utf-8'); } catch { return ''; }
}

/**
 * Decide which shim to install when OpenClaw is NOT detected. Picks Node OR
 * Python based on cwd shape. When BOTH are present (full-stack monorepo
 * with package.json AND pyproject.toml) the caller is responsible for
 * resolving the ambiguity (interactively, or default to JS in --yes mode
 * per the team decision in the plan).
 *
 * Returns one of:
 *   { kind: 'node',   evidence: [...] }
 *   { kind: 'python', evidence: [...] }
 *   { kind: 'both',   node: {...}, python: {...} }
 *   { kind: null }     — unknown project shape, no clear path
 */
export function detectAgentRuntime(cwd = process.cwd()) {
  const node = detectNodeAgent(cwd);
  const python = detectPythonAgent(cwd);
  if (node && python) return { kind: 'both', node, python };
  if (node) return { kind: 'node', evidence: node.evidence };
  if (python) return { kind: 'python', evidence: python.evidence };
  return { kind: null };
}
