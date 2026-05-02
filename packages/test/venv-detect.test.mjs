import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
}));

vi.mock('node:path', () => ({
  join: vi.fn((...args) => args.join('/')),
}));

const spawnSyncMock = vi.fn();
vi.mock('node:child_process', () => ({
  spawnSync: spawnSyncMock,
}));

const { existsSync } = await import('node:fs');
const { detectVenv, runPipInstall } = await import('../lib/venv-detect.js');

let originalVirtualEnv;

beforeEach(() => {
  vi.clearAllMocks();
  existsSync.mockReturnValue(false);
  originalVirtualEnv = process.env.VIRTUAL_ENV;
  delete process.env.VIRTUAL_ENV;
});

afterEach(() => {
  if (originalVirtualEnv === undefined) delete process.env.VIRTUAL_ENV;
  else process.env.VIRTUAL_ENV = originalVirtualEnv;
});

describe('detectVenv — resolution order', () => {
  it('returns active venv when VIRTUAL_ENV is set and python exists', () => {
    process.env.VIRTUAL_ENV = '/some/active/venv';
    existsSync.mockImplementation((p) =>
      String(p) === '/some/active/venv/bin/python',
    );
    const result = detectVenv('/cwd');
    expect(result.python).toBe('/some/active/venv/bin/python');
    expect(result.kind).toBe('active');
    expect(result.confidence).toBe('high');
  });

  it('falls back to python3 if python missing in active venv', () => {
    process.env.VIRTUAL_ENV = '/some/active/venv';
    existsSync.mockImplementation((p) =>
      String(p) === '/some/active/venv/bin/python3',
    );
    const result = detectVenv('/cwd');
    expect(result.python).toBe('/some/active/venv/bin/python3');
    expect(result.kind).toBe('active');
  });

  it('returns ./.venv when no active venv', () => {
    existsSync.mockImplementation((p) => String(p) === '/cwd/.venv/bin/python');
    const result = detectVenv('/cwd');
    expect(result.python).toBe('/cwd/.venv/bin/python');
    expect(result.kind).toBe('cwd-venv');
  });

  it('returns ./venv as second-priority cwd venv', () => {
    existsSync.mockImplementation((p) => String(p) === '/cwd/venv/bin/python');
    const result = detectVenv('/cwd');
    expect(result.python).toBe('/cwd/venv/bin/python');
    expect(result.kind).toBe('cwd-venv');
  });

  it('bails with low confidence when no venv found', () => {
    const result = detectVenv('/empty');
    expect(result.python).toBeNull();
    expect(result.kind).toBe('none');
    expect(result.confidence).toBe('low');
  });

  it('NEVER returns system python — refuses to silently install into it', () => {
    // Simulate ALL possible venv locations missing
    existsSync.mockReturnValue(false);
    delete process.env.VIRTUAL_ENV;
    const result = detectVenv('/cwd');
    expect(result.python).toBeNull();
  });
});

describe('runPipInstall', () => {
  it('returns ok=true on exit code 0', () => {
    spawnSyncMock.mockReturnValue({ status: 0, stderr: '' });
    const result = runPipInstall({ python: '/v/bin/python', packageSpec: 'robot-resources>=0.2.0' });
    expect(result.ok).toBe(true);
    expect(spawnSyncMock).toHaveBeenCalledWith(
      '/v/bin/python',
      ['-m', 'pip', 'install', '--upgrade', 'robot-resources>=0.2.0'],
      expect.objectContaining({ encoding: 'utf-8' }),
    );
  });

  it('returns ok=false + stderr tail on non-zero exit', () => {
    spawnSyncMock.mockReturnValue({
      status: 1,
      stderr: 'a'.repeat(2000) + 'TAIL_MARKER',
    });
    const result = runPipInstall({ python: '/v/bin/python', packageSpec: 'robot-resources' });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(1);
    expect(result.stderr.length).toBeLessThanOrEqual(500);
    expect(result.stderr).toContain('TAIL_MARKER');
  });

  it('returns ok=false when no python given', () => {
    const result = runPipInstall({ python: null, packageSpec: 'foo' });
    expect(result.ok).toBe(false);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });
});
