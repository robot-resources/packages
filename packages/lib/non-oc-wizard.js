import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { select } from '@inquirer/prompts';
import { isClaudeCodeInstalled, isCursorInstalled, detectAgentRuntime } from './detect.js';
import { configureClaudeCode, configureCursor } from './tool-config.js';
import { header, info, success, warn, blank } from './ui.js';
import { readConfig } from './config.mjs';
import { installNodeShim } from './install-node-shim.js';
import { installPythonShim } from './install-python-shim.js';

const PLATFORM_URL = process.env.RR_PLATFORM_URL || 'https://api.robotresources.ai';

const PATH_LABELS = {
  js: 'JS/TS agent (LangChain, LangGraph, Mastra, etc.)',
  python: 'Python agent (LangChain, LlamaIndex, CrewAI, etc.)',
  mcp: 'Cursor / Claude Code / other MCP tool',
  docs: "Just point me at docs, I'll integrate manually",
  'install-oc': 'Install OpenClaw first — exit',
};

const VALID_TARGETS = new Set(Object.keys(PATH_LABELS).concat(['langchain', 'claude-code']));

/**
 * Inspect cwd to guess what the user is building. Returns one of the path
 * keys, or null if we can't tell. Order matters: detect-by-file beats
 * detect-by-installed-tool, since cwd evidence is stronger than "the user
 * has Cursor installed somewhere on this machine."
 */
export function detectDefaultPath(cwd = process.cwd()) {
  const pkgPath = join(cwd, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      const allDeps = {
        ...(pkg.dependencies ?? {}),
        ...(pkg.devDependencies ?? {}),
      };
      const jsAgentMarkers = ['langchain', '@langchain/core', '@langchain/langgraph', '@mastra/core', 'crewai-js', 'llamaindex'];
      if (jsAgentMarkers.some((m) => Object.prototype.hasOwnProperty.call(allDeps, m))) {
        return 'js';
      }
      // Generic JS project still defaults to JS (cheaper than asking).
      return 'js';
    } catch {
      // fall through
    }
  }

  if (existsSync(join(cwd, 'requirements.txt')) || existsSync(join(cwd, 'pyproject.toml'))) {
    return 'python';
  }

  if (isCursorInstalled() || isClaudeCodeInstalled()) {
    return 'mcp';
  }

  return null;
}

function normalizeTarget(target) {
  if (!target) return null;
  const t = String(target).toLowerCase();
  if (!VALID_TARGETS.has(t)) return null;
  // Aliases — friendly synonyms map to canonical path keys.
  if (t === 'langchain') return 'js';
  if (t === 'claude-code') return 'mcp';
  return t;
}

async function emitPathChosen(path) {
  const config = readConfig();
  if (!config.api_key) return; // wizard didn't get to provision; can't authenticate
  try {
    await fetch(`${PLATFORM_URL}/v1/telemetry`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.api_key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        product: 'cli',
        event_type: 'wizard_path_chosen',
        payload: { path, platform: process.platform },
      }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // Best-effort — never let telemetry break the install path.
  }
}

async function showJsPath() {
  blank();
  success('JS/TS integration');
  blank();

  const result = await installNodeShim();
  if (result.ok) {
    if (result.already) {
      info(result.message);
    } else {
      success(result.message);
      for (const path of result.written ?? []) {
        info(`  • ${path}`);
      }
    }
    blank();
    info('Once your shell picks up the new NODE_OPTIONS, every Node agent on');
    info('this machine routes Anthropic SDK calls through Robot Resources.');
    info('Open a new terminal — or run:  source ~/.zshrc   (or your shell rc)');
  } else {
    warn(result.message);
    blank();
    info('Manual install (paste into ~/.zshrc or ~/.bashrc):');
    info('  export NODE_OPTIONS="${NODE_OPTIONS:-} --require @robot-resources/router/auto"');
  }
  blank();
  info('Docs: https://robotresources.ai/docs/langchain');
  blank();
}

async function showPythonPath() {
  blank();
  success('Python integration');
  blank();

  const result = await installPythonShim();
  if (result.ok) {
    success(result.message);
    if (result.sdks?.length) {
      info(`  Detected SDKs: ${result.sdks.join(', ')}`);
    }
    blank();
    info('Set RR_AUTOATTACH=1 in your shell, then run your Python agent.');
    info('Every anthropic.Anthropic() instance routes through Robot Resources.');
    info('  echo \'export RR_AUTOATTACH=1\' >> ~/.zshrc   # or your shell rc');
  } else {
    warn(result.message);
    blank();
    info('Manual install (run inside your venv):');
    info('  pip install --upgrade robot-resources');
    info('Then set:');
    info('  export RR_AUTOATTACH=1');
  }
  blank();
  info('Docs: https://robotresources.ai/docs/crewai');
  blank();
}

function showMcpPath() {
  blank();
  success('MCP tool integration');
  blank();
  let cursorOk = false;
  let claudeOk = false;
  if (isCursorInstalled()) {
    try {
      const result = configureCursor();
      cursorOk = result?.action === 'configured' || result?.action === 'already_configured';
      info(`Cursor: ${cursorOk ? 'configured' : 'see manual instructions below'}`);
    } catch {
      warn('Cursor: failed to write ~/.cursor/mcp.json automatically');
    }
  }
  if (isClaudeCodeInstalled()) {
    try {
      const result = configureClaudeCode();
      claudeOk = result?.action === 'configured' || result?.action === 'already_configured';
      info(`Claude Code: ${claudeOk ? 'configured' : 'see manual instructions below'}`);
    } catch {
      warn('Claude Code: failed to write ~/.claude/settings.json automatically');
    }
  }
  if (!cursorOk && !claudeOk) {
    info('We did not detect Cursor or Claude Code on this machine.');
    info('Manual setup: https://robotresources.ai/docs/cursor-mcp');
  }
  blank();
}

function showDocsPath() {
  blank();
  success('Docs');
  blank();
  info('Integration guides: https://robotresources.ai/docs');
  info('HTTP API:          https://robotresources.ai/docs/http-api');
  info('GitHub:            https://github.com/robot-resources/packages');
  blank();
}

function showInstallOcPath() {
  blank();
  info('OpenClaw is the easiest way to use Robot Resources.');
  info('Install OpenClaw first (https://openclaw.dev), then re-run:');
  info('  npx robot-resources');
  blank();
}

async function runPath(path) {
  switch (path) {
    case 'js': await showJsPath(); break;
    case 'python': await showPythonPath(); break;
    case 'mcp': showMcpPath(); break;
    case 'docs': showDocsPath(); break;
    case 'install-oc': showInstallOcPath(); break;
    default: showInstallOcPath(); break;
  }
}

/**
 * Runs the non-OC wizard. Three modes:
 * - target supplied (--for=<target>): run that path directly, no prompt
 * - non-interactive AND no target: print hint with --for= options and exit
 * - interactive: 5-option menu via @inquirer/prompts.select
 */
export async function runNonOcWizard({ nonInteractive = false, target = null } = {}) {
  const normalized = normalizeTarget(target);

  if (normalized) {
    await runPath(normalized);
    await emitPathChosen(normalized);
    return;
  }

  if (nonInteractive) {
    // Phase 3.5: when project shape is unambiguous (cwd has a package.json
    // OR a Python project file), auto-install the matching shim instead of
    // bailing with a hint. CI/agents running `npx robot-resources` from
    // their repo are exactly this case — making them pass `--for=` is
    // friction we don't need.
    //
    // The Phase 3 noninteractive_no_target path is preserved for the case
    // where detection finds nothing (truly empty cwd, generic shell run).
    const runtime = detectAgentRuntime();
    let autoTarget = null;
    if (runtime.kind === 'node' || runtime.kind === 'both') autoTarget = 'js';
    else if (runtime.kind === 'python') autoTarget = 'python';

    if (autoTarget) {
      // Brief context so the install step doesn't feel sudden.
      info(`Detected a ${autoTarget === 'js' ? 'Node' : 'Python'} project — installing the matching shim automatically.`);
      info('  Pass --for=<other> to override, or --uninstall to remove later.');
      blank();
      await runPath(autoTarget);
      await emitPathChosen(autoTarget);
      return;
    }

    info('Robot Resources requires OpenClaw, which we did not detect on this machine.');
    info('To bypass this prompt in CI / non-TTY contexts, re-run with --for=<target>:');
    info('  npx robot-resources --for=langchain      # JS/TS agent');
    info('  npx robot-resources --for=python         # Python agent');
    info('  npx robot-resources --for=cursor         # Cursor MCP config');
    info('  npx robot-resources --for=claude-code    # Claude Code MCP config');
    info('  npx robot-resources --for=docs           # docs URL');
    blank();
    await emitPathChosen('noninteractive_no_target');
    return;
  }

  // Interactive menu.
  header();
  info('Robot Resources requires OpenClaw, which we did not detect on this machine.');
  info('What are you building? Pick the closest match — we\'ll show the install steps.');
  blank();

  const defaultPath = detectDefaultPath() ?? 'js';

  let chosen;
  try {
    chosen = await select({
      message: 'What are you building?',
      default: defaultPath,
      choices: [
        { name: PATH_LABELS.js, value: 'js' },
        { name: PATH_LABELS.python, value: 'python' },
        { name: PATH_LABELS.mcp, value: 'mcp' },
        { name: PATH_LABELS.docs, value: 'docs' },
        { name: PATH_LABELS['install-oc'], value: 'install-oc' },
      ],
    });
  } catch (err) {
    // User hit Ctrl-C or terminal closed — exit cleanly, but mark the funnel
    // so we can distinguish "agent shown the prompt and bailed" from
    // "wizard never reached the prompt at all" in Supabase.
    if (err && (err.name === 'ExitPromptError' || err.code === 'ABORT_ERR')) {
      await emitPathChosen('aborted');
      return;
    }
    throw err;
  }

  await runPath(chosen);
  await emitPathChosen(chosen);
}
