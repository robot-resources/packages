import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_CORE_PATH = join(__dirname, '..', '..', 'lib', 'plugin-core.js');

// Replaces the manual grep gate from the PR1 plan.
// Delete this file in PR2 — that's when plugin-core.js is allowed to swap
// askRouter() to the in-process implementation.
describe('PR1 invariant: plugin-core still calls askRouter over HTTP', () => {
  it('contains a fetch call to /v1/route', () => {
    const src = readFileSync(PLUGIN_CORE_PATH, 'utf-8');
    expect(src).toMatch(/fetch\([^)]*\/v1\/route/);
  });
});
