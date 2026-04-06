import {
  findPython,
  ensureVenv,
  installRouter,
  isRouterInstalled,
  getVenvPythonPath,
} from '@robot-resources/cli-core/python-bridge.mjs';

// Re-export shared primitives used by wizard.js and other CLI code.
export { ensureVenv, isRouterInstalled, getVenvPythonPath };

/**
 * Full setup: find Python, create venv, install router.
 * Returns { venvPython, pythonVersion } or throws.
 */
export async function setupRouter() {
  const python = findPython();
  if (!python) {
    throw new Error(
      'Python 3.10+ not found. Install Python from https://python.org and try again.\n' +
      '  The Router requires Python. Scraper and MCP tools work without it.'
    );
  }

  const venvPython = ensureVenv(python.bin);
  await installRouter();
  return { venvPython, pythonVersion: python.version };
}
