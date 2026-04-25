import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CLASSIFICATION_PROMPT } from '../../lib/routing/classify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const ROUTER_VENV_PY = join(REPO_ROOT, 'router', '.venv', 'bin', 'python');
const PYTHON_CMD = existsSync(ROUTER_VENV_PY) ? ROUTER_VENV_PY : 'python3';

// Suppress structlog warnings emitted during selector module init by
// redirecting stdout while we import. Then restore stdout and write the
// CLASSIFICATION_PROMPT byte-verbatim.
const PY_SCRIPT = `
import sys, os, io
sys.path.insert(0, os.path.join(os.environ['REPO_ROOT'], 'router', 'src'))
_orig = sys.stdout
sys.stdout = io.StringIO()
from robot_resources.routing.classifier import CLASSIFICATION_PROMPT
sys.stdout = _orig
sys.stdout.write(CLASSIFICATION_PROMPT)
`;

describe('CLASSIFICATION_PROMPT cross-language byte parity', () => {
  it('JS string is byte-identical to Python CLASSIFICATION_PROMPT', () => {
    const result = spawnSync(PYTHON_CMD, ['-c', PY_SCRIPT], {
      env: { ...process.env, REPO_ROOT },
      encoding: 'utf-8',
    });

    if (result.error || result.status !== 0) {
      // Python unavailable in this environment — skip without failing.
      // The CI python-tests job runs Python so this is asserted there.
      console.warn(
        `[skip] Python unavailable for cross-language assertion: ${result.error?.message ?? result.stderr}`,
      );
      return;
    }

    expect(JS_TO_BYTES(CLASSIFICATION_PROMPT)).toEqual(JS_TO_BYTES(result.stdout));
  });
});

function JS_TO_BYTES(s) {
  return Array.from(new TextEncoder().encode(s));
}
