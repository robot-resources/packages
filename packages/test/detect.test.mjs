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
const { getOpenClawAuthMode, isOpenClawPluginInstalled, isScraperOcPluginInstalled, isClaudeCodeInstalled, isCursorInstalled } =
  await import('../lib/detect.js');

describe('detect', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Restore homedir mock after reset (detect.js calls homedir() per function)
    os.homedir.mockReturnValue('/mock-home');
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
    it('detects robot-resources-router directory', () => {
      existsSync.mockImplementation((p) => p.includes('robot-resources-router'));
      expect(isOpenClawPluginInstalled()).toBe(true);
    });

    it('detects legacy openclaw-plugin directory', () => {
      existsSync.mockImplementation((p) => p.includes('openclaw-plugin'));
      expect(isOpenClawPluginInstalled()).toBe(true);
    });

    it('returns false when neither directory exists', () => {
      existsSync.mockReturnValue(false);
      expect(isOpenClawPluginInstalled()).toBe(false);
    });
  });

  // ── isScraperOcPluginInstalled ────────────────────────────

  describe('isScraperOcPluginInstalled', () => {
    it('detects robot-resources-scraper-oc-plugin directory', () => {
      existsSync.mockImplementation((p) => p.includes('robot-resources-scraper-oc-plugin'));
      expect(isScraperOcPluginInstalled()).toBe(true);
    });

    it('returns false when directory does not exist', () => {
      existsSync.mockReturnValue(false);
      expect(isScraperOcPluginInstalled()).toBe(false);
    });
  });

  // ── isClaudeCodeInstalled ─────────────────────────────────

  describe('isClaudeCodeInstalled', () => {
    it('returns true when ~/.claude/ exists', () => {
      existsSync.mockImplementation((p) => p.includes('.claude'));
      expect(isClaudeCodeInstalled()).toBe(true);
    });

    it('returns false when ~/.claude/ does not exist', () => {
      existsSync.mockReturnValue(false);
      expect(isClaudeCodeInstalled()).toBe(false);
    });
  });

  // ── isCursorInstalled ─────────────────────────────────────

  describe('isCursorInstalled', () => {
    it('returns true when ~/.cursor/ exists', () => {
      existsSync.mockImplementation((p) => p.includes('.cursor'));
      expect(isCursorInstalled()).toBe(true);
    });

    it('returns false when ~/.cursor/ does not exist', () => {
      existsSync.mockReturnValue(false);
      expect(isCursorInstalled()).toBe(false);
    });
  });
});
