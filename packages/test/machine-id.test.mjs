import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/mock-home'),
}));

vi.mock('node:crypto', () => ({
  randomUUID: vi.fn(() => 'aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee'),
}));

const { readFileSync, writeFileSync, mkdirSync } = await import('node:fs');
const { homedir } = await import('node:os');
const { randomUUID } = await import('node:crypto');
const { getOrCreateMachineId } = await import('../lib/machine-id.js');

describe('getOrCreateMachineId', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    homedir.mockReturnValue('/mock-home');
    randomUUID.mockReturnValue('aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee');
  });

  it('returns existing UUID from file when read succeeds', () => {
    readFileSync.mockReturnValue('11111111-2222-3333-4444-555555555555');

    const result = getOrCreateMachineId('/tmp/rr');

    expect(result).toBe('11111111-2222-3333-4444-555555555555');
    expect(randomUUID).not.toHaveBeenCalled();
  });

  it('creates new UUID when file does not exist', () => {
    readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });

    const result = getOrCreateMachineId('/tmp/rr');

    expect(result).toBe('aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee');
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it('writes the new UUID to disk', () => {
    readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });

    getOrCreateMachineId('/tmp/rr');

    expect(writeFileSync).toHaveBeenCalledWith(
      join('/tmp/rr', '.machine-id'),
      'aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee',
      'utf-8',
    );
  });

  it('creates parent directory recursively before writing', () => {
    readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });

    getOrCreateMachineId('/tmp/rr');

    expect(mkdirSync).toHaveBeenCalledWith('/tmp/rr', { recursive: true });
    // Verify mkdir was called before writeFile by checking call order
    const mkdirOrder = mkdirSync.mock.invocationCallOrder[0];
    const writeOrder = writeFileSync.mock.invocationCallOrder[0];
    expect(mkdirOrder).toBeLessThan(writeOrder);
  });

  it('handles EACCES on write gracefully and still returns UUID', () => {
    readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    mkdirSync.mockImplementation(() => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); });

    const result = getOrCreateMachineId('/tmp/rr');

    expect(result).toBe('aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee');
  });

  it('trims whitespace from file read', () => {
    readFileSync.mockReturnValue('  11111111-2222-3333-4444-555555555555\n');

    const result = getOrCreateMachineId('/tmp/rr');

    expect(result).toBe('11111111-2222-3333-4444-555555555555');
  });

  it('returns valid UUID v4 format', () => {
    readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    randomUUID.mockReturnValue('f47ac10b-58cc-4372-a567-0e02b2c3d479');

    const result = getOrCreateMachineId('/tmp/rr');

    expect(result).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('generates new UUID when file exists but is empty', () => {
    readFileSync.mockReturnValue('   \n');

    const result = getOrCreateMachineId('/tmp/rr');

    expect(result).toBe('aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee');
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it('uses ~/.robot-resources as default directory when configDir is omitted', () => {
    readFileSync.mockReturnValue('existing-uuid');

    getOrCreateMachineId();

    expect(readFileSync).toHaveBeenCalledWith(
      join('/mock-home', '.robot-resources', '.machine-id'),
      'utf-8',
    );
  });

  it('does not write when existing UUID is found', () => {
    readFileSync.mockReturnValue('existing-uuid');

    getOrCreateMachineId('/tmp/rr');

    expect(writeFileSync).not.toHaveBeenCalled();
    expect(mkdirSync).not.toHaveBeenCalled();
  });
});
