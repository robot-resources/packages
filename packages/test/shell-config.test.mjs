import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  statSync: vi.fn(() => ({ mode: 0o644 })),
}));

vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/mock/home'),
}));

vi.mock('node:path', () => ({
  join: vi.fn((...args) => args.join('/')),
}));

const { existsSync, readFileSync, writeFileSync, appendFileSync } = await import('node:fs');
const {
  listShellRcFiles,
  hasShellLine,
  writeShellLine,
  removeShellLine,
  MARK_BEGIN,
  MARK_END,
  POSIX_LINE,
  FISH_LINE,
} = await import('../lib/shell-config.js');

beforeEach(() => {
  vi.clearAllMocks();
  existsSync.mockReturnValue(false);
  readFileSync.mockReturnValue('');
});

describe('listShellRcFiles', () => {
  it('returns only rc files that exist', () => {
    existsSync.mockImplementation((p) => String(p).endsWith('.zshrc'));
    const list = listShellRcFiles();
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({ kind: 'zsh', path: '/mock/home/.zshrc' });
  });

  it('returns multiple when several rc files exist', () => {
    existsSync.mockImplementation((p) =>
      String(p).endsWith('.zshrc') || String(p).endsWith('.bashrc'),
    );
    const list = listShellRcFiles();
    expect(list).toHaveLength(2);
    expect(list.map((r) => r.kind)).toEqual(['zsh', 'bash']);
  });

  it('detects fish config', () => {
    existsSync.mockImplementation((p) => String(p).endsWith('config.fish'));
    const list = listShellRcFiles();
    expect(list[0].kind).toBe('fish');
  });
});

describe('hasShellLine', () => {
  it('returns false when no rc files exist', () => {
    existsSync.mockReturnValue(false);
    expect(hasShellLine()).toBe(false);
  });

  it('returns true when at least one rc has the marker block', () => {
    existsSync.mockImplementation((p) => String(p).endsWith('.zshrc'));
    readFileSync.mockReturnValue(`# user stuff\n${MARK_BEGIN}\n${POSIX_LINE}\n${MARK_END}\n`);
    expect(hasShellLine()).toBe(true);
  });

  it('returns false when rc exists but lacks the marker', () => {
    existsSync.mockImplementation((p) => String(p).endsWith('.zshrc'));
    readFileSync.mockReturnValue('# unrelated user content\nexport FOO=bar\n');
    expect(hasShellLine()).toBe(false);
  });
});

describe('writeShellLine', () => {
  it('appends a marker block when zsh rc exists and lacks our line', () => {
    existsSync.mockImplementation((p) => String(p).endsWith('.zshrc'));
    readFileSync.mockReturnValue('export FOO=1\n');
    const result = writeShellLine();
    expect(result.written).toEqual(['/mock/home/.zshrc']);
    expect(result.errors).toEqual([]);
    expect(appendFileSync).toHaveBeenCalledOnce();
    const [path, content] = appendFileSync.mock.calls[0];
    expect(path).toBe('/mock/home/.zshrc');
    expect(content).toContain(MARK_BEGIN);
    expect(content).toContain(POSIX_LINE);
    expect(content).toContain(MARK_END);
  });

  it('writes fish syntax to fish config', () => {
    existsSync.mockImplementation((p) => String(p).endsWith('config.fish'));
    readFileSync.mockReturnValue('');
    writeShellLine();
    const [, content] = appendFileSync.mock.calls[0];
    expect(content).toContain(FISH_LINE);
    expect(content).not.toContain(POSIX_LINE);
  });

  it('is idempotent when marker already present (no append)', () => {
    existsSync.mockImplementation((p) => String(p).endsWith('.zshrc'));
    readFileSync.mockReturnValue(`${MARK_BEGIN}\n${POSIX_LINE}\n${MARK_END}\n`);
    const result = writeShellLine();
    expect(result.written).toEqual([]);
    expect(appendFileSync).not.toHaveBeenCalled();
  });

  it('writes to ALL detected rc files (zsh + bash)', () => {
    existsSync.mockImplementation((p) =>
      String(p).endsWith('.zshrc') || String(p).endsWith('.bashrc'),
    );
    readFileSync.mockReturnValue('');
    const result = writeShellLine();
    expect(result.written).toHaveLength(2);
    expect(appendFileSync).toHaveBeenCalledTimes(2);
  });

  it('falls back to creating a default rc on macOS when none exist', () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    existsSync.mockReturnValue(false);
    const result = writeShellLine();
    expect(result.written).toEqual(['/mock/home/.zshrc']);
    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
  });

  it('captures per-file errors without aborting', () => {
    existsSync.mockImplementation((p) =>
      String(p).endsWith('.zshrc') || String(p).endsWith('.bashrc'),
    );
    readFileSync.mockReturnValue('');
    appendFileSync.mockImplementationOnce(() => { throw new Error('EACCES'); });
    const result = writeShellLine();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toBe('EACCES');
    // The other file should still get written
    expect(result.written).toHaveLength(1);
  });
});

describe('removeShellLine', () => {
  it('strips the marker block from rc files that contain it', () => {
    existsSync.mockImplementation((p) => String(p).endsWith('.zshrc'));
    const before = `export FOO=1\n\n${MARK_BEGIN}\n${POSIX_LINE}\n${MARK_END}\nexport BAR=2\n`;
    readFileSync.mockReturnValue(before);
    const result = removeShellLine();
    expect(result.removed).toEqual(['/mock/home/.zshrc']);
    expect(writeFileSync).toHaveBeenCalledOnce();
    const after = writeFileSync.mock.calls[0][1];
    expect(after).not.toContain(MARK_BEGIN);
    expect(after).not.toContain(MARK_END);
    expect(after).toContain('export FOO=1');
    expect(after).toContain('export BAR=2');
  });

  it('is a no-op on rc files without the marker', () => {
    existsSync.mockImplementation((p) => String(p).endsWith('.zshrc'));
    readFileSync.mockReturnValue('export FOO=1\n');
    const result = removeShellLine();
    expect(result.removed).toEqual([]);
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it('captures malformed marker (missing END) as an error', () => {
    existsSync.mockImplementation((p) => String(p).endsWith('.zshrc'));
    readFileSync.mockReturnValue(`${MARK_BEGIN}\n${POSIX_LINE}\n# user removed end marker\n`);
    const result = removeShellLine();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toBe('marker_end_missing');
    expect(writeFileSync).not.toHaveBeenCalled();
  });
});
