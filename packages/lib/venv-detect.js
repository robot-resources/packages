import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * Resolve the Python interpreter we'll use for `pip install robot-resources`.
 *
 * Resolution order (decided in the plan; never silently install into system
 * Python — that can break OS Python on Linux):
 *
 *   1. $VIRTUAL_ENV — currently-active venv. Strongest signal.
 *   2. ./.venv/bin/python — common cwd venv (uv, hatch, plain venv default).
 *   3. ./venv/bin/python — alternative cwd venv name.
 *   4. pyproject.toml [tool.uv]/[tool.poetry] hint — best effort.
 *   5. Bail with confidence='low'. Caller prompts user or errors out with
 *      a `--python=/path/to/python` instruction in non-interactive mode.
 *
 * Returns:
 *   { python: string, kind: 'active'|'cwd-venv'|'pyproject', confidence: 'high' }
 *   OR
 *   { python: null,   kind: 'none',                          confidence: 'low' }
 */
export function detectVenv(cwd = process.cwd()) {
  // 1. Active venv — strongest signal.
  const activeVenv = process.env.VIRTUAL_ENV;
  if (activeVenv) {
    const candidate = join(activeVenv, binSubdir(), 'python');
    const candidate3 = join(activeVenv, binSubdir(), 'python3');
    if (existsSync(candidate)) {
      return { python: candidate, kind: 'active', confidence: 'high' };
    }
    if (existsSync(candidate3)) {
      return { python: candidate3, kind: 'active', confidence: 'high' };
    }
  }

  // 2. ./.venv (uv default, hatch default, plain venv default)
  for (const dirname of ['.venv', 'venv']) {
    const venvDir = join(cwd, dirname);
    const cands = [
      join(venvDir, binSubdir(), 'python'),
      join(venvDir, binSubdir(), 'python3'),
    ];
    for (const c of cands) {
      if (existsSync(c)) {
        return { python: c, kind: 'cwd-venv', confidence: 'high' };
      }
    }
  }

  // 4. Bail. Never silently install into system Python.
  return { python: null, kind: 'none', confidence: 'low' };
}

function binSubdir() {
  return process.platform === 'win32' ? 'Scripts' : 'bin';
}

/**
 * Run `python -m pip install <package>` against the resolved interpreter.
 * Captures exit code + stderr tail for telemetry. Never throws.
 *
 * Phase 3 ships with `--upgrade` so existing 0.1.0 installs migrate to
 * the auto-attach-capable 0.2.0 transparently.
 */
export function runPipInstall({ python, packageSpec, timeoutMs = 120_000 }) {
  if (!python) {
    return { ok: false, code: -1, stderr: 'no python interpreter resolved' };
  }
  const args = ['-m', 'pip', 'install', '--upgrade', packageSpec];
  const result = spawnSync(python, args, {
    encoding: 'utf-8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Trim stderr to a sane size for telemetry — pip's full output is huge.
  const stderr = (result.stderr || '').slice(-500);

  return {
    ok: result.status === 0,
    code: result.status,
    stderr,
  };
}
