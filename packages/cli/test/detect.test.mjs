import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/mock-home'),
}));

const { execSync, execFileSync } = await import('node:child_process');
const { existsSync, readFileSync } = await import('node:fs');
const os = await import('node:os');
const { findPython, isPortAvailable, isServiceRegistered, checkRouterVenv, getOpenClawAuthMode, isOpenClawPluginInstalled } =
  await import('../lib/detect.js');

describe('detect', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Restore homedir mock after reset (detect.js calls homedir() per function)
    os.homedir.mockReturnValue('/mock-home');
  });

  describe('findPython', () => {
    it('returns the first Python 3.10+ binary found', () => {
      execSync
        .mockImplementationOnce(() => { throw new Error('not found'); }) // python3.13
        .mockImplementationOnce(() => 'Python 3.12.1')                   // python3.12
        .mockImplementationOnce(() => 'Python 3.12.1');                   // not called

      const result = findPython();

      expect(result).toEqual({ bin: 'python3.12', version: '3.12' });
    });

    it('returns null when no Python 3.10+ is found', () => {
      execSync.mockImplementation(() => { throw new Error('not found'); });

      const result = findPython();

      expect(result).toBeNull();
    });

    it('skips Python versions below 3.10', () => {
      // All candidates fail except python3 which returns 3.9
      execSync.mockImplementation((cmd) => {
        if (cmd.startsWith('python3 ')) return 'Python 3.9.7';
        if (cmd.startsWith('python ')) return 'Python 3.8.2';
        throw new Error('not found');
      });

      const result = findPython();

      expect(result).toBeNull();
    });

    it('prefers higher version candidates (tries 3.13 before 3.12)', () => {
      execSync.mockImplementation((cmd) => {
        if (cmd.startsWith('python3.13 ')) return 'Python 3.13.0';
        if (cmd.startsWith('python3.12 ')) return 'Python 3.12.1';
        throw new Error('not found');
      });

      const result = findPython();

      expect(result).toEqual({ bin: 'python3.13', version: '3.13' });
    });

    it('accepts Python 3.10 as the minimum version', () => {
      execSync.mockImplementation((cmd) => {
        if (cmd.startsWith('python3.10 ')) return 'Python 3.10.0';
        throw new Error('not found');
      });

      const result = findPython();

      expect(result).toEqual({ bin: 'python3.10', version: '3.10' });
    });

    it('rejects Python 2.x', () => {
      execSync.mockImplementation((cmd) => {
        if (cmd.startsWith('python ')) return 'Python 2.7.18';
        throw new Error('not found');
      });

      const result = findPython();

      expect(result).toBeNull();
    });

    it('falls back to plain "python" when python3 variants are unavailable', () => {
      execSync.mockImplementation((cmd) => {
        if (cmd.startsWith('python ')) return 'Python 3.11.4';
        throw new Error('not found');
      });

      const result = findPython();

      expect(result).toEqual({ bin: 'python', version: '3.11' });
    });
  });

  describe('isPortAvailable', () => {
    it('returns true when lsof finds no process on port (throws)', () => {
      execFileSync.mockImplementation(() => { throw new Error('exit code 1'); });

      expect(isPortAvailable(3838)).toBe(true);
    });

    it('returns false when lsof finds a process on port', () => {
      execFileSync.mockReturnValue('12345');

      expect(isPortAvailable(3838)).toBe(false);
    });

    it('defaults to port 3838 when no argument is given', () => {
      execFileSync.mockImplementation(() => { throw new Error(''); });

      isPortAvailable();

      expect(execFileSync).toHaveBeenCalledWith(
        'lsof',
        expect.arrayContaining([':3838']),
        expect.any(Object),
      );
    });

    it('checks the specified port number', () => {
      execFileSync.mockImplementation(() => { throw new Error(''); });

      isPortAvailable(9999);

      expect(execFileSync).toHaveBeenCalledWith(
        'lsof',
        expect.arrayContaining([':9999']),
        expect.any(Object),
      );
    });
  });

  describe('isServiceRegistered', () => {
    it('checks for launchd plist on macOS', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

      existsSync.mockReturnValue(true);

      const result = isServiceRegistered();

      expect(result).toBe(true);
      expect(existsSync).toHaveBeenCalledWith(
        expect.stringContaining('ai.robotresources.router.plist'),
      );

      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    });

    it('checks for systemd unit on Linux', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

      existsSync.mockReturnValue(true);

      const result = isServiceRegistered();

      expect(result).toBe(true);
      expect(existsSync).toHaveBeenCalledWith(
        expect.stringContaining('robot-resources-router.service'),
      );

      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    });

    it('returns false on unsupported platforms', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

      const result = isServiceRegistered();

      expect(result).toBe(false);

      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    });

    it('returns false when plist does not exist on macOS', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

      existsSync.mockReturnValue(false);

      expect(isServiceRegistered()).toBe(false);

      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    });
  });

  describe('checkRouterVenv', () => {
    it('returns null when venv python does not exist', () => {
      existsSync.mockReturnValue(false);

      const result = checkRouterVenv();

      expect(result).toBeNull();
    });

    it('returns venv info when python exists and package is importable', () => {
      existsSync.mockReturnValue(true);
      execSync.mockReturnValue('');

      const result = checkRouterVenv();

      expect(result).not.toBeNull();
      expect(result.venvDir).toContain('.robot-resources');
      expect(result.venvPython).toBeDefined();
    });

    it('returns null when python exists but package import fails', () => {
      existsSync.mockReturnValue(true);
      execSync.mockImplementation(() => { throw new Error('ModuleNotFoundError'); });

      const result = checkRouterVenv();

      expect(result).toBeNull();
    });
  });

  describe('getOpenClawAuthMode', () => {
    let savedEnv;

    beforeEach(() => {
      savedEnv = { ...process.env };
      delete process.env.ANTHROPIC_AUTH_TOKEN;
      delete process.env.ANTHROPIC_API_KEY;
    });

    afterEach(() => {
      process.env = savedEnv;
    });

    it('returns subscription when ANTHROPIC_AUTH_TOKEN is set', () => {
      process.env.ANTHROPIC_AUTH_TOKEN = 'oauth-token-xxx';
      expect(getOpenClawAuthMode()).toBe('subscription');
    });

    it('returns apikey when ANTHROPIC_API_KEY is set', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-xxx';
      expect(getOpenClawAuthMode()).toBe('apikey');
    });

    it('prefers ANTHROPIC_AUTH_TOKEN over ANTHROPIC_API_KEY', () => {
      process.env.ANTHROPIC_AUTH_TOKEN = 'oauth-token-xxx';
      process.env.ANTHROPIC_API_KEY = 'sk-ant-xxx';
      expect(getOpenClawAuthMode()).toBe('subscription');
    });

    it('reads auth.type from openclaw.json', () => {
      existsSync.mockImplementation((p) => p.includes('openclaw.json'));
      readFileSync.mockReturnValue(JSON.stringify({
        auth: { type: 'oauth' },
      }));

      expect(getOpenClawAuthMode()).toBe('subscription');
    });

    it('detects authToken in providers.anthropic', () => {
      existsSync.mockImplementation((p) => p.includes('openclaw.json'));
      readFileSync.mockReturnValue(JSON.stringify({
        models: { providers: { anthropic: { authToken: 'token-xxx' } } },
      }));

      expect(getOpenClawAuthMode()).toBe('subscription');
    });

    it('detects apiKey in providers.anthropic', () => {
      existsSync.mockImplementation((p) => p.includes('openclaw.json'));
      readFileSync.mockReturnValue(JSON.stringify({
        models: { providers: { anthropic: { apiKey: 'sk-ant-xxx' } } },
      }));

      expect(getOpenClawAuthMode()).toBe('apikey');
    });

    it('handles JSON5 config with comments', () => {
      existsSync.mockImplementation((p) => p.includes('openclaw.json'));
      readFileSync.mockReturnValue(`{
        // Auth config
        "auth": { "type": "subscription" },
      }`);

      expect(getOpenClawAuthMode()).toBe('subscription');
    });

    it('detects token mode in auth.profiles (real OC config)', () => {
      existsSync.mockImplementation((p) => p.includes('openclaw.json'));
      readFileSync.mockReturnValue(JSON.stringify({
        auth: {
          profiles: {
            'anthropic:default': {
              provider: 'anthropic',
              mode: 'token',
            },
          },
        },
      }));

      expect(getOpenClawAuthMode()).toBe('subscription');
    });

    it('detects token mode in gateway.auth', () => {
      existsSync.mockImplementation((p) => p.includes('openclaw.json'));
      readFileSync.mockReturnValue(JSON.stringify({
        gateway: { auth: { mode: 'token' } },
      }));

      expect(getOpenClawAuthMode()).toBe('subscription');
    });

    it('returns apikey when auth.profiles mode is not token', () => {
      existsSync.mockImplementation((p) => p.includes('openclaw.json'));
      readFileSync.mockReturnValue(JSON.stringify({
        auth: {
          profiles: {
            'anthropic:default': {
              provider: 'anthropic',
              mode: 'apikey',
            },
          },
        },
      }));

      expect(getOpenClawAuthMode()).toBe('apikey');
    });

    it('defaults to apikey when no config found', () => {
      existsSync.mockReturnValue(false);
      expect(getOpenClawAuthMode()).toBe('apikey');
    });

    it('defaults to apikey on config read error', () => {
      existsSync.mockImplementation((p) => p.includes('openclaw.json'));
      readFileSync.mockImplementation(() => { throw new Error('EACCES'); });

      expect(getOpenClawAuthMode()).toBe('apikey');
    });

    // ── TKT-140: Missing path coverage ──

    it('detects subscription via flat providers.anthropic.authToken', () => {
      existsSync.mockImplementation((p) => p.includes('openclaw.json'));
      readFileSync.mockReturnValue(JSON.stringify({
        providers: {
          anthropic: { authToken: 'sk-ant-oat01-xxx' },
        },
      }));

      expect(getOpenClawAuthMode()).toBe('subscription');
    });

    it('detects apikey via flat providers.anthropic.apiKey', () => {
      existsSync.mockImplementation((p) => p.includes('openclaw.json'));
      readFileSync.mockReturnValue(JSON.stringify({
        providers: {
          anthropic: { apiKey: 'sk-ant-xxx' },
        },
      }));

      expect(getOpenClawAuthMode()).toBe('apikey');
    });

    it('detects subscription via auth.type oauth', () => {
      existsSync.mockImplementation((p) => p.includes('openclaw.json'));
      readFileSync.mockReturnValue(JSON.stringify({
        auth: { type: 'oauth' },
      }));

      expect(getOpenClawAuthMode()).toBe('subscription');
    });
  });

  // ── TKT-140: isOpenClawPluginInstalled dual-directory ──

  describe('isOpenClawPluginInstalled', () => {
    it('detects openclaw-plugin directory', () => {
      existsSync.mockImplementation((p) => p.includes('openclaw-plugin'));
      expect(isOpenClawPluginInstalled()).toBe(true);
    });

    it('detects legacy robot-resources-router directory', () => {
      existsSync.mockImplementation((p) => p.includes('robot-resources-router'));
      expect(isOpenClawPluginInstalled()).toBe(true);
    });

    it('returns false when neither directory exists', () => {
      existsSync.mockReturnValue(false);
      expect(isOpenClawPluginInstalled()).toBe(false);
    });
  });
});
