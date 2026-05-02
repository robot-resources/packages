import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// install-node-shim.js
vi.mock('../lib/shell-config.js', () => ({
  writeShellLine: vi.fn(),
  hasShellLine: vi.fn(),
}));

// install-python-shim.js
vi.mock('../lib/venv-detect.js', () => ({
  detectVenv: vi.fn(),
  runPipInstall: vi.fn(),
}));

vi.mock('../lib/detect.js', () => ({
  detectNodeAgent: vi.fn(() => ({ evidence: ['@anthropic-ai/sdk'] })),
  detectPythonAgent: vi.fn(() => ({ evidence: ['anthropic'] })),
}));

vi.mock('../lib/config.mjs', () => ({
  readConfig: vi.fn(() => ({ api_key: 'rr_live_test' })),
}));

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(() => ({ stdout: 'Python 3.11.9\n', stderr: '' })),
}));

const { writeShellLine, hasShellLine } = await import('../lib/shell-config.js');
const { detectVenv, runPipInstall } = await import('../lib/venv-detect.js');
const { readConfig } = await import('../lib/config.mjs');
const { installNodeShim } = await import('../lib/install-node-shim.js');
const { installPythonShim } = await import('../lib/install-python-shim.js');

let originalPlatform;

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
  readConfig.mockReturnValue({ api_key: 'rr_live_test' });
  hasShellLine.mockReturnValue(false);
  writeShellLine.mockReturnValue({ written: ['/mock/.zshrc'], errors: [] });
  detectVenv.mockReturnValue({ python: '/v/bin/python', kind: 'cwd-venv', confidence: 'high' });
  runPipInstall.mockReturnValue({ ok: true, code: 0, stderr: '' });
  originalPlatform = process.platform;
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
});

describe('installNodeShim — happy path', () => {
  it('writes shell line + emits node_shim_installed telemetry', async () => {
    const result = await installNodeShim();
    expect(result.ok).toBe(true);
    expect(writeShellLine).toHaveBeenCalledOnce();
    const calls = globalThis.fetch.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('/v1/telemetry'),
    );
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0][1].body);
    expect(body.event_type).toBe('node_shim_installed');
    expect(body.payload.sdks_detected).toContain('@anthropic-ai/sdk');
  });

  it('returns ok=true with already=true when shell already had the line', async () => {
    hasShellLine.mockReturnValue(true);
    writeShellLine.mockReturnValue({ written: [], errors: [] });
    const result = await installNodeShim();
    expect(result.ok).toBe(true);
    expect(result.already).toBe(true);
  });
});

describe('installNodeShim — Windows', () => {
  it('refuses to write on win32 and returns reason=windows_not_supported_yet', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const result = await installNodeShim();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('windows_not_supported_yet');
    expect(writeShellLine).not.toHaveBeenCalled();
  });
});

describe('installNodeShim — failure path', () => {
  it('returns ok=false when writeShellLine reports only errors', async () => {
    writeShellLine.mockReturnValue({
      written: [],
      errors: [{ path: '/mock/.zshrc', message: 'EACCES' }],
    });
    const result = await installNodeShim();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('EACCES');
  });

  it('does not emit telemetry when no api_key (skips fetch)', async () => {
    readConfig.mockReturnValue({});
    await installNodeShim();
    const calls = globalThis.fetch.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('/v1/telemetry'),
    );
    expect(calls).toHaveLength(0);
  });
});

describe('installNodeShim — dryRun', () => {
  it('skips writeShellLine and returns ok=true', async () => {
    const result = await installNodeShim({ dryRun: true });
    expect(result.ok).toBe(true);
    expect(writeShellLine).not.toHaveBeenCalled();
  });
});

describe('installPythonShim — happy path', () => {
  it('runs pip install + emits python_shim_installed', async () => {
    const result = await installPythonShim();
    expect(result.ok).toBe(true);
    expect(runPipInstall).toHaveBeenCalledWith({
      python: '/v/bin/python',
      packageSpec: 'robot-resources>=0.2.0',
    });
    const calls = globalThis.fetch.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('/v1/telemetry'),
    );
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0][1].body);
    expect(body.event_type).toBe('python_shim_installed');
    expect(body.payload.kind).toBe('cwd-venv');
    expect(body.payload.pip_exit_code).toBe(0);
    expect(body.payload.sdks_detected).toContain('anthropic');
  });
});

describe('installPythonShim — no venv', () => {
  it('returns ok=false with reason=no_venv_found and emits failure telemetry', async () => {
    detectVenv.mockReturnValue({ python: null, kind: 'none', confidence: 'low' });
    const result = await installPythonShim();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no_venv_found');
    expect(runPipInstall).not.toHaveBeenCalled();
    const calls = globalThis.fetch.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('/v1/telemetry'),
    );
    const body = JSON.parse(calls[0][1].body);
    expect(body.payload.kind).toBe('none');
    expect(body.payload.reason).toBe('no_venv_found');
  });
});

describe('installPythonShim — pip failure', () => {
  it('returns ok=false with stderr tail in telemetry', async () => {
    runPipInstall.mockReturnValue({ ok: false, code: 1, stderr: 'wheel build failed' });
    const result = await installPythonShim();
    expect(result.ok).toBe(false);
    const calls = globalThis.fetch.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('/v1/telemetry'),
    );
    const body = JSON.parse(calls[0][1].body);
    expect(body.payload.pip_exit_code).toBe(1);
    expect(body.payload.pip_stderr_tail).toContain('wheel build failed');
  });
});
