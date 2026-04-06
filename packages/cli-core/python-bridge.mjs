import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const VENV_DIR = join(homedir(), '.robot-resources', '.venv');
const ROUTER_PACKAGE = 'robot-resources-router';

const PYTHON_CANDIDATES = [
  'python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3', 'python',
];

/**
 * Find a Python 3.10+ binary on the system.
 * Returns { bin, version } or null if not found.
 */
export function findPython() {
  for (const bin of PYTHON_CANDIDATES) {
    try {
      const output = execSync(`${bin} --version 2>&1`, { encoding: 'utf-8' }).trim();
      const match = output.match(/Python (\d+)\.(\d+)/);
      if (match) {
        const [, major, minor] = match.map(Number);
        if (major === 3 && minor >= 10) {
          return { bin, version: `${major}.${minor}` };
        }
      }
    } catch {
      // binary not found, try next
    }
  }
  return null;
}

/**
 * Get the Python binary path inside the managed venv.
 */
export function getVenvPython() {
  return process.platform === 'win32'
    ? join(VENV_DIR, 'Scripts', 'python.exe')
    : join(VENV_DIR, 'bin', 'python3');
}

/**
 * Get the pip binary path inside the managed venv.
 */
export function getVenvPip() {
  return process.platform === 'win32'
    ? join(VENV_DIR, 'Scripts', 'pip.exe')
    : join(VENV_DIR, 'bin', 'pip3');
}

/**
 * Create a Python venv at ~/.robot-resources/.venv if it doesn't exist.
 * Validates an existing venv and recreates if broken.
 * Returns the path to the venv Python binary.
 *
 * @param {string} pythonBin — system Python binary to use for venv creation
 */
export function ensureVenv(pythonBin) {
  const venvPython = getVenvPython();

  if (existsSync(venvPython)) {
    try {
      execSync(`"${venvPython}" --version`, { stdio: 'pipe' });
      return venvPython;
    } catch {
      // Broken venv — recreate below
    }
  }

  // Pre-check: verify the venv module is available (missing on some Debian/Ubuntu systems)
  try {
    execSync(`"${pythonBin}" -c "import ensurepip; import venv"`, { stdio: 'pipe' });
  } catch {
    const version = execSync(`"${pythonBin}" --version`, { encoding: 'utf-8' }).trim().match(/\d+\.\d+/)?.[0] || '3.x';
    throw new Error(
      `Python venv module is not installed.\n` +
      `  Fix: sudo apt install python${version}-venv   (Debian/Ubuntu)\n` +
      `  Then re-run: npx robot-resources`
    );
  }

  mkdirSync(join(homedir(), '.robot-resources'), { recursive: true });
  execSync(`"${pythonBin}" -m venv "${VENV_DIR}"`, { stdio: 'pipe' });
  return venvPython;
}

/**
 * Install (or upgrade) the router Python package into the managed venv.
 * Prints progress every 5 seconds to keep terminal sessions alive
 * (OC session handlers reap silent processes).
 *
 * @param {object} [options]
 * @param {number} [options.timeout=120000] — pip install timeout in ms
 */
export function installRouter({ timeout = 120_000 } = {}) {
  const pip = getVenvPip();

  return new Promise((resolve, reject) => {
    const proc = spawn(pip, ['install', '--upgrade', ROUTER_PACKAGE], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
    });

    process.stdout.write('  Installing dependencies...\n');
    let seconds = 0;
    const progress = setInterval(() => {
      seconds += 4;
      process.stdout.write(`  Installing dependencies... ${seconds}s\n`);
    }, 4000);

    proc.on('close', (code) => {
      clearInterval(progress);
      if (code === 0) resolve();
      else reject(new Error(`pip install exited with code ${code}`));
    });

    proc.on('error', (err) => {
      clearInterval(progress);
      reject(err);
    });
  });
}

/**
 * Check if the router Python package is importable in the managed venv.
 */
export function isRouterInstalled() {
  const venvPython = getVenvPython();
  if (!existsSync(venvPython)) return false;

  try {
    execSync(`"${venvPython}" -c "import robot_resources"`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the managed venv's Python path (convenience alias for service registration, etc.).
 */
export function getVenvPythonPath() {
  return getVenvPython();
}

/** Expose the venv directory path for advanced use cases. */
export const MANAGED_VENV_DIR = VENV_DIR;

/** Expose the router pip package name. */
export const ROUTER_PIP_PACKAGE = ROUTER_PACKAGE;
