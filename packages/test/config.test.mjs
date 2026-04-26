import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';

// Mock node:fs before importing the module under test
vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/mock-home'),
}));

const { readFileSync, writeFileSync, mkdirSync } = await import('node:fs');
const { readConfig, writeConfig, clearConfig, getConfigPath, getConfigDir, readProviderKeys, writeProviderKeys } =
  await import('../config.mjs');

describe('config', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    // Restore homedir mock after reset (called at module load, but needed if re-imported)
    const os = await import('node:os');
    os.homedir.mockReturnValue('/mock-home');
  });

  describe('getConfigPath', () => {
    it('returns path under homedir/.robot-resources/config.json', () => {
      const path = getConfigPath();
      expect(path).toBe(join('/mock-home', '.robot-resources', 'config.json'));
    });
  });

  describe('getConfigDir', () => {
    it('returns path under homedir/.robot-resources', () => {
      const dir = getConfigDir();
      expect(dir).toBe(join('/mock-home', '.robot-resources'));
    });
  });

  describe('readConfig', () => {
    it('returns parsed JSON when config file exists', () => {
      readFileSync.mockReturnValue('{"api_key":"test-key","user_name":"alice"}');

      const config = readConfig();

      expect(config).toEqual({ api_key: 'test-key', user_name: 'alice' });
      expect(readFileSync).toHaveBeenCalledWith(
        join('/mock-home', '.robot-resources', 'config.json'),
        'utf-8',
      );
    });

    it('returns empty object when file does not exist', () => {
      readFileSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const config = readConfig();

      expect(config).toEqual({});
    });

    it('returns empty object when file contains invalid JSON', () => {
      readFileSync.mockReturnValue('not-json{{{');

      const config = readConfig();

      expect(config).toEqual({});
    });
  });

  describe('writeConfig', () => {
    it('creates config directory recursively', () => {
      readFileSync.mockReturnValue('{}');

      writeConfig({ api_key: 'new-key' });

      expect(mkdirSync).toHaveBeenCalledWith(
        join('/mock-home', '.robot-resources'),
        { recursive: true },
      );
    });

    it('merges new data with existing config', () => {
      readFileSync.mockReturnValue('{"user_name":"alice"}');

      const result = writeConfig({ api_key: 'new-key' });

      expect(result).toEqual({ user_name: 'alice', api_key: 'new-key' });
    });

    it('writes merged config as formatted JSON with mode 0o600', () => {
      readFileSync.mockReturnValue('{"user_name":"alice"}');

      writeConfig({ api_key: 'new-key' });

      expect(writeFileSync).toHaveBeenCalledWith(
        join('/mock-home', '.robot-resources', 'config.json'),
        JSON.stringify({ user_name: 'alice', api_key: 'new-key' }, null, 2) + '\n',
        { mode: 0o600 },
      );
    });

    it('overwrites existing keys when merging', () => {
      readFileSync.mockReturnValue('{"api_key":"old-key","user_name":"alice"}');

      const result = writeConfig({ api_key: 'new-key' });

      expect(result.api_key).toBe('new-key');
      expect(result.user_name).toBe('alice');
    });

    it('handles fresh config when no file exists yet', () => {
      readFileSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const result = writeConfig({ api_key: 'first-key' });

      expect(result).toEqual({ api_key: 'first-key' });
    });
  });

  describe('clearConfig', () => {
    it('writes empty JSON object to config file', () => {
      clearConfig();

      expect(writeFileSync).toHaveBeenCalledWith(
        join('/mock-home', '.robot-resources', 'config.json'),
        '{}\n',
        { mode: 0o600 },
      );
    });

    it('does not throw when config file does not exist', () => {
      writeFileSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      expect(() => clearConfig()).not.toThrow();
    });
  });

  describe('readProviderKeys', () => {
    it('returns provider_keys sub-object from config', () => {
      readFileSync.mockReturnValue(
        JSON.stringify({ api_key: 'x', provider_keys: { openai: 'sk-123', anthropic: 'ant-456' } }),
      );

      const keys = readProviderKeys();

      expect(keys).toEqual({ openai: 'sk-123', anthropic: 'ant-456' });
    });

    it('returns empty object when provider_keys is absent', () => {
      readFileSync.mockReturnValue('{"api_key":"x"}');

      const keys = readProviderKeys();

      expect(keys).toEqual({});
    });

    it('returns empty object when config file is missing', () => {
      readFileSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const keys = readProviderKeys();

      expect(keys).toEqual({});
    });
  });

  describe('writeProviderKeys', () => {
    it('merges new keys into existing provider_keys', () => {
      readFileSync.mockReturnValue(
        JSON.stringify({ api_key: 'x', provider_keys: { openai: 'sk-old' } }),
      );

      const result = writeProviderKeys({ anthropic: 'ant-new' });

      expect(result.provider_keys).toEqual({ openai: 'sk-old', anthropic: 'ant-new' });
      expect(result.api_key).toBe('x');
    });

    it('creates provider_keys when none exist', () => {
      readFileSync.mockReturnValue('{"api_key":"x"}');

      const result = writeProviderKeys({ google: 'goog-123' });

      expect(result.provider_keys).toEqual({ google: 'goog-123' });
    });

    it('writes file with mode 0o600', () => {
      readFileSync.mockReturnValue('{}');

      writeProviderKeys({ openai: 'sk-test' });

      expect(writeFileSync).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        { mode: 0o600 },
      );
    });
  });
});
