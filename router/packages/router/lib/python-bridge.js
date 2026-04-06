import { execSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  findPython,
  ensureVenv,
  installRouter,
  getVenvPython,
} from '@robot-resources/cli-core/python-bridge.mjs';

/**
 * Ensure Python 3.10+ is available and the venv has the router installed.
 * Shows install output to the terminal (stdio: 'inherit').
 * Returns the venv Python path.
 */
export async function ensurePythonSetup() {
  const venvPython = getVenvPython();

  // Fast path: venv exists and router is importable
  if (existsSync(venvPython)) {
    try {
      execSync(`"${venvPython}" -c "import robot_resources"`, { stdio: 'pipe' });
      return venvPython;
    } catch {
      // router not installed in existing venv — continue to install
    }
  }

  // Find system Python
  const python = findPython();
  if (!python) {
    throw new Error(
      'Python 3.10+ is required but not found.\n' +
      'Install from https://python.org and try again.'
    );
  }

  // Create venv if needed
  ensureVenv(python.bin);

  // Install router package (show output so users see progress)
  installRouter({ stdio: 'inherit' });

  return getVenvPython();
}

/**
 * Spawn the Python router CLI with the given arguments.
 * Returns the exit code.
 */
export function spawnRouter(pythonPath, args) {
  return new Promise((resolve) => {
    const child = spawn(pythonPath, ['-m', 'robot_resources.cli.main', ...args], {
      stdio: 'inherit',
      env: process.env,
    });

    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}
