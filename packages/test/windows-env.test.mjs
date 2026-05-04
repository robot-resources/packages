import { describe, it, expect, vi, beforeEach } from 'vitest';

// spawnSync is the only system-level dependency. We mock it per-test to
// simulate `reg query` and `setx` behavior without touching the real
// Windows registry (these tests run on Linux/macOS CI).
const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({
  spawnSync: spawnMock,
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/mock/home'),
}));

vi.mock('node:path', () => ({
  join: vi.fn((...args) => args.join('/')),
}));

const { existsSync, readFileSync, writeFileSync } = await import('node:fs');
const {
  readPersistedNodeOptions,
  writePersistedNodeOptions,
  removePersistedNodeOptions,
} = await import('../lib/windows-env.js');

beforeEach(() => {
  vi.clearAllMocks();
  existsSync.mockReturnValue(false);
});

// Helper to mock a `reg query` response shape
function mockRegQueryReturns(value) {
  return (cmd, args) => {
    if (cmd === 'reg.exe' && args[0] === 'query') {
      if (value === null) {
        return { status: 1, stdout: '', stderr: 'ERROR: The system was unable to find the specified registry key or value.' };
      }
      return {
        status: 0,
        stdout: `\nHKEY_CURRENT_USER\\Environment\n    NODE_OPTIONS    REG_SZ    ${value}\n\n`,
        stderr: '',
      };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
}

// ── readPersistedNodeOptions ────────────────────────────────────────────

describe('readPersistedNodeOptions', () => {
  it('returns the value when reg query succeeds', () => {
    spawnMock.mockImplementation(mockRegQueryReturns('--require /home/me/auto.cjs'));
    expect(readPersistedNodeOptions()).toBe('--require /home/me/auto.cjs');
  });

  it('returns empty string when the var is not set', () => {
    spawnMock.mockImplementation(mockRegQueryReturns(null));
    expect(readPersistedNodeOptions()).toBe('');
  });

  it('returns null when reg query fails for unknown reasons', () => {
    spawnMock.mockReturnValue({ status: 2, stdout: '', stderr: 'something else' });
    expect(readPersistedNodeOptions()).toBeNull();
  });
});

// ── writePersistedNodeOptions ───────────────────────────────────────────

describe('writePersistedNodeOptions', () => {
  it('returns ok=false when autoPath is missing', () => {
    const result = writePersistedNodeOptions({});
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('missing_auto_path');
  });

  it('appends our --require to an empty NODE_OPTIONS', () => {
    spawnMock.mockImplementation((cmd, args) => {
      if (cmd === 'reg.exe') return mockRegQueryReturns('')(cmd, args);
      if (cmd === 'setx.exe') return { status: 0, stdout: 'SUCCESS', stderr: '' };
      return { status: 0 };
    });
    const result = writePersistedNodeOptions({ autoPath: 'C:\\Users\\x\\.robot-resources\\router\\auto.cjs' });
    expect(result.ok).toBe(true);
    expect(result.already).toBe(false);
    expect(result.written).toContain('--require "C:\\Users\\x\\.robot-resources\\router\\auto.cjs"');
    // setx was called with the merged value
    const setxCalls = spawnMock.mock.calls.filter((c) => c[0] === 'setx.exe');
    expect(setxCalls).toHaveLength(1);
    expect(setxCalls[0][1]).toEqual(['NODE_OPTIONS', expect.stringContaining('--require')]);
  });

  it('appends our --require AFTER existing NODE_OPTIONS (preserves user tooling like dd-trace)', () => {
    spawnMock.mockImplementation((cmd, args) => {
      if (cmd === 'reg.exe') return mockRegQueryReturns('--require dd-trace/init')(cmd, args);
      if (cmd === 'setx.exe') return { status: 0, stdout: 'SUCCESS', stderr: '' };
      return { status: 0 };
    });
    const result = writePersistedNodeOptions({ autoPath: 'C:\\Users\\x\\auto.cjs' });
    expect(result.ok).toBe(true);
    expect(result.written).toBe('--require dd-trace/init --require "C:\\Users\\x\\auto.cjs"');
  });

  it('is idempotent — already=true when our --require is already present', () => {
    const existing = '--require dd-trace/init --require "C:\\Users\\x\\auto.cjs"';
    spawnMock.mockImplementation((cmd, args) => {
      if (cmd === 'reg.exe') return mockRegQueryReturns(existing)(cmd, args);
      return { status: 0 };
    });
    const result = writePersistedNodeOptions({ autoPath: 'C:\\Users\\x\\auto.cjs' });
    expect(result.ok).toBe(true);
    expect(result.already).toBe(true);
    // setx should NOT have been called
    expect(spawnMock.mock.calls.filter((c) => c[0] === 'setx.exe')).toHaveLength(0);
  });

  it('refuses to write when merged value would exceed setx 1024-char limit', () => {
    const longExisting = '--require ' + 'a'.repeat(1100);
    spawnMock.mockImplementation((cmd, args) => {
      if (cmd === 'reg.exe') return mockRegQueryReturns(longExisting)(cmd, args);
      return { status: 0 };
    });
    const result = writePersistedNodeOptions({ autoPath: 'C:\\Users\\x\\auto.cjs' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('setx_limit_exceeded');
    // setx must NOT be called when over limit — refuses rather than truncate
    expect(spawnMock.mock.calls.filter((c) => c[0] === 'setx.exe')).toHaveLength(0);
  });

  it('reports setx_failed with stderr when setx exits non-zero', () => {
    spawnMock.mockImplementation((cmd, args) => {
      if (cmd === 'reg.exe') return mockRegQueryReturns('')(cmd, args);
      if (cmd === 'setx.exe') return { status: 1, stdout: '', stderr: 'ERROR: Access is denied.' };
      return { status: 0 };
    });
    const result = writePersistedNodeOptions({ autoPath: 'C:\\Users\\x\\auto.cjs' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('setx_failed');
    expect(result.error_message).toContain('Access is denied');
  });

  it('writes a backup of the prior value before overwriting', () => {
    spawnMock.mockImplementation((cmd, args) => {
      if (cmd === 'reg.exe') return mockRegQueryReturns('--require dd-trace/init')(cmd, args);
      if (cmd === 'setx.exe') return { status: 0 };
      return { status: 0 };
    });
    writePersistedNodeOptions({ autoPath: 'C:\\Users\\x\\auto.cjs' });
    // Backup file should have been written with the prior value.
    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('windows-prior-node-options.txt'),
      '--require dd-trace/init',
      expect.any(Object),
    );
  });
});

// ── removePersistedNodeOptions ──────────────────────────────────────────

describe('removePersistedNodeOptions', () => {
  it('clears the registry value when no backup exists', () => {
    spawnMock.mockImplementation((cmd, args) => {
      if (cmd === 'reg.exe' && args[0] === 'query') {
        return mockRegQueryReturns('--require x')(cmd, args);
      }
      if (cmd === 'reg.exe' && args[0] === 'delete') {
        return { status: 0, stdout: 'The operation completed successfully.', stderr: '' };
      }
      return { status: 0 };
    });
    existsSync.mockReturnValue(false); // no backup file

    const result = removePersistedNodeOptions();
    expect(result.ok).toBe(true);
    expect(result.action).toBe('cleared');
    const delCalls = spawnMock.mock.calls.filter(
      (c) => c[0] === 'reg.exe' && c[1][0] === 'delete',
    );
    expect(delCalls).toHaveLength(1);
  });

  it('restores the prior value from backup when present', () => {
    spawnMock.mockImplementation((cmd, args) => {
      if (cmd === 'reg.exe' && args[0] === 'query') {
        return mockRegQueryReturns('--require dd --require ours')(cmd, args);
      }
      if (cmd === 'setx.exe') {
        return { status: 0, stdout: 'SUCCESS', stderr: '' };
      }
      return { status: 0 };
    });
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue('--require dd-trace/init');

    const result = removePersistedNodeOptions();
    expect(result.ok).toBe(true);
    expect(result.action).toBe('restored');
    expect(result.restored_to).toBe('--require dd-trace/init');
    const setxCalls = spawnMock.mock.calls.filter((c) => c[0] === 'setx.exe');
    expect(setxCalls).toHaveLength(1);
    expect(setxCalls[0][1]).toEqual(['NODE_OPTIONS', '--require dd-trace/init']);
  });

  it('is a noop when registry already has no NODE_OPTIONS', () => {
    spawnMock.mockImplementation((cmd, args) => {
      if (cmd === 'reg.exe' && args[0] === 'query') {
        return mockRegQueryReturns(null)(cmd, args); // not set
      }
      return { status: 0 };
    });
    const result = removePersistedNodeOptions();
    expect(result.action).toBe('noop');
  });
});
