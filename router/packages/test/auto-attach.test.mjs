import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');
const AUTO_PATH = resolve(PKG_ROOT, 'auto.cjs');
const require = createRequire(import.meta.url);

describe('package surface — ./auto export', () => {
  it('package.json maps ./auto to ./auto.cjs', () => {
    const pkg = require('../package.json');
    expect(pkg.exports['./auto']).toBe('./auto.cjs');
  });

  it('auto.cjs is included in package.json files[]', () => {
    const pkg = require('../package.json');
    expect(pkg.files).toContain('auto.cjs');
  });

  it('auto.cjs exists on disk', () => {
    expect(existsSync(AUTO_PATH)).toBe(true);
  });
});

// Spawn a child Node with `--require ./auto.cjs` to verify the env-var
// behavior end-to-end. Phase 1 is gated by RR_AUTOATTACH=1; the child also
// gets RR_AUTOATTACH_DRY_RUN=1 (declared below) to skip the dynamic import +
// server bind, so the test stays a pure env-var assertion.
function runChild(envOverrides, script = 'console.log(process.env.ANTHROPIC_BASE_URL || "UNSET")') {
  const result = spawnSync(process.execPath, ['--require', AUTO_PATH, '-e', script], {
    env: { ...process.env, ...envOverrides },
    encoding: 'utf-8',
    timeout: 10_000,
  });
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim(), status: result.status };
}

describe('auto.cjs — gating (Phase 7: opt-out semantics)', () => {
  it('sets ANTHROPIC_BASE_URL when RR_AUTOATTACH is unset (default ON)', () => {
    const { stdout } = runChild({
      RR_AUTOATTACH: '',
      ANTHROPIC_BASE_URL: '',
      RR_AUTOATTACH_DRY_RUN: '1',
    });
    expect(stdout).toBe('http://127.0.0.1:18790/anthropic');
  });

  it('sets ANTHROPIC_BASE_URL when RR_AUTOATTACH=1 (explicit on, same as default)', () => {
    const { stdout } = runChild({
      RR_AUTOATTACH: '1',
      ANTHROPIC_BASE_URL: '',
      RR_AUTOATTACH_DRY_RUN: '1',
    });
    expect(stdout).toBe('http://127.0.0.1:18790/anthropic');
  });

  it('does NOT set ANTHROPIC_BASE_URL when RR_AUTOATTACH=0 (explicit opt-out)', () => {
    const { stdout } = runChild({
      RR_AUTOATTACH: '0',
      ANTHROPIC_BASE_URL: '',
      RR_AUTOATTACH_DRY_RUN: '1',
    });
    expect(stdout).toBe('UNSET');
  });

  it('respects an existing ANTHROPIC_BASE_URL — never clobbers a user override', () => {
    const userUrl = 'https://my-corporate-proxy.example.com';
    const { stdout } = runChild({
      ANTHROPIC_BASE_URL: userUrl,
      RR_AUTOATTACH_DRY_RUN: '1',
    });
    expect(stdout).toBe(userUrl);
  });

  it('still attaches Anthropic env-var even when OPENAI_BASE_URL is set (per-SDK override scope)', () => {
    // Phase 7 fix: previously a single user-set env var caused us to skip
    // ALL adapters. Now each SDK's env var is respected independently.
    const result = spawnSync(process.execPath, ['--require', AUTO_PATH, '-e',
      'console.log(JSON.stringify({a: process.env.ANTHROPIC_BASE_URL, o: process.env.OPENAI_BASE_URL}))',
    ], {
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: '',
        OPENAI_BASE_URL: 'https://my-openai-proxy.example.com',
        RR_AUTOATTACH_DRY_RUN: '1',
      },
      encoding: 'utf-8',
      timeout: 10_000,
    });
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.a).toBe('http://127.0.0.1:18790/anthropic');
    expect(parsed.o).toBe('https://my-openai-proxy.example.com');
  });

  it('singleton guard: loading auto.cjs twice is safe', () => {
    // Use NODE_OPTIONS to load auto.cjs once, then explicitly require it
    // again from inside the script. Second load must early-return without
    // touching state. Verify by checking the env var is set exactly once
    // and no error is printed.
    const result = spawnSync(
      process.execPath,
      [
        '--require', AUTO_PATH,
        '-e',
        `require(${JSON.stringify(AUTO_PATH)}); console.log(process.env.ANTHROPIC_BASE_URL || "UNSET")`,
      ],
      {
        env: { ...process.env, ANTHROPIC_BASE_URL: '', RR_AUTOATTACH_DRY_RUN: '1' },
        encoding: 'utf-8',
        timeout: 10_000,
      },
    );
    expect(result.stdout.trim()).toBe('http://127.0.0.1:18790/anthropic');
    expect(result.status).toBe(0);
  });
});
