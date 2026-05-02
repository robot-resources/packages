import { spawnSync } from 'node:child_process';
import { detectVenv, runPipInstall } from './venv-detect.js';
import { readConfig } from './config.mjs';
import { detectPythonAgent } from './detect.js';

const PLATFORM_URL = process.env.RR_PLATFORM_URL || 'https://api.robotresources.ai';

/**
 * Install the Python shim into the user's active/cwd venv. Phase 3 entry
 * for the non-OC Python path.
 *
 * Steps:
 *   1. Resolve Python via detectVenv. Bail with `confidence: 'low'` if we
 *      can't find a venv — we never `pip install` into system Python (can
 *      break OS Python on Linux).
 *   2. Run `pip install --upgrade robot-resources`. Captures exit code +
 *      stderr tail for telemetry.
 *   3. Emit `python_shim_installed` telemetry with venv kind, Python
 *      version, detected SDK markers, pip exit code.
 *
 * Returns a UI-friendly result the wizard can format and print. Never
 * throws — any unexpected error becomes a structured `{ ok: false, ... }`.
 */
export async function installPythonShim({ cwd = process.cwd() } = {}) {
  const venv = detectVenv(cwd);

  if (!venv.python) {
    await emit({
      kind: 'none',
      python_version: null,
      sdks_detected: detectSdks(cwd),
      pip_exit_code: null,
      reason: 'no_venv_found',
    });
    return {
      ok: false,
      reason: 'no_venv_found',
      message:
        'No active venv or ./.venv detected. Activate your venv first ' +
        '(source .venv/bin/activate) or pass --python=/path/to/python, ' +
        'then re-run.',
    };
  }

  const pipResult = runPipInstall({
    python: venv.python,
    packageSpec: 'robot-resources>=0.2.0',
  });

  const pythonVersion = readPythonVersion(venv.python);
  const sdks = detectSdks(cwd);

  await emit({
    kind: venv.kind,
    python_version: pythonVersion,
    sdks_detected: sdks,
    pip_exit_code: pipResult.code,
    pip_stderr_tail: pipResult.ok ? null : pipResult.stderr,
  });

  return {
    ok: pipResult.ok,
    venv,
    pythonVersion,
    sdks,
    pipResult,
    message: pipResult.ok
      ? `Installed robot-resources into ${venv.kind} venv (${venv.python})`
      : `pip install failed (exit ${pipResult.code}): ${pipResult.stderr.slice(0, 200)}`,
  };
}

function detectSdks(cwd) {
  const result = detectPythonAgent(cwd);
  return result?.evidence ?? [];
}

function readPythonVersion(python) {
  try {
    const r = spawnSync(python, ['--version'], { encoding: 'utf-8' });
    return (r.stdout || r.stderr || '').trim().replace(/^Python\s+/, '');
  } catch {
    return null;
  }
}

async function emit(payload) {
  const config = readConfig();
  if (!config.api_key) return;
  try {
    await fetch(`${PLATFORM_URL}/v1/telemetry`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.api_key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        product: 'cli',
        event_type: 'python_shim_installed',
        payload: { ...payload, platform: process.platform },
      }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // Best-effort — never let telemetry break the install path.
  }
}
