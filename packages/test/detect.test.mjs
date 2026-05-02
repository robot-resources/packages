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
const {
  getOpenClawAuthMode,
  isOpenClawPluginInstalled,
  isScraperOcPluginInstalled,
  isClaudeCodeInstalled,
  isCursorInstalled,
  detectNodeAgent,
  detectPythonAgent,
  detectAgentRuntime,
} = await import('../lib/detect.js');

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

  // ── detectNodeAgent ───────────────────────────────────────

  describe('detectNodeAgent', () => {
    it('returns null when no package.json', () => {
      existsSync.mockReturnValue(false);
      expect(detectNodeAgent('/proj')).toBeNull();
    });

    it('returns evidence for @anthropic-ai/sdk dep', () => {
      existsSync.mockImplementation((p) => String(p).endsWith('package.json'));
      readFileSync.mockReturnValue(JSON.stringify({
        dependencies: { '@anthropic-ai/sdk': '^0.30' },
      }));
      const result = detectNodeAgent('/proj');
      expect(result.evidence).toContain('@anthropic-ai/sdk');
    });

    it('returns evidence for langchain + openai (multiple matches)', () => {
      existsSync.mockImplementation((p) => String(p).endsWith('package.json'));
      readFileSync.mockReturnValue(JSON.stringify({
        dependencies: { langchain: '^0.1', openai: '^4.0' },
      }));
      const result = detectNodeAgent('/proj');
      expect(result.evidence).toEqual(expect.arrayContaining(['langchain', 'openai']));
    });

    it('returns empty evidence for generic package.json (no LLM SDK)', () => {
      existsSync.mockImplementation((p) => String(p).endsWith('package.json'));
      readFileSync.mockReturnValue(JSON.stringify({
        dependencies: { express: '^4.0' },
      }));
      const result = detectNodeAgent('/proj');
      expect(result.evidence).toEqual([]);
    });

    it('also scans devDependencies', () => {
      existsSync.mockImplementation((p) => String(p).endsWith('package.json'));
      readFileSync.mockReturnValue(JSON.stringify({
        devDependencies: { '@google/generative-ai': '^1.0' },
      }));
      const result = detectNodeAgent('/proj');
      expect(result.evidence).toContain('@google/generative-ai');
    });

    it('returns empty evidence on malformed package.json (still claims Node)', () => {
      existsSync.mockImplementation((p) => String(p).endsWith('package.json'));
      readFileSync.mockReturnValue('{not valid json');
      const result = detectNodeAgent('/proj');
      expect(result).toEqual({ evidence: [] });
    });
  });

  // ── detectPythonAgent ──────────────────────────────────────

  describe('detectPythonAgent', () => {
    it('returns null when no requirements.txt or pyproject.toml', () => {
      existsSync.mockReturnValue(false);
      expect(detectPythonAgent('/proj')).toBeNull();
    });

    it('detects anthropic in requirements.txt', () => {
      existsSync.mockImplementation((p) => String(p).endsWith('requirements.txt'));
      readFileSync.mockReturnValue('anthropic==0.30.0\nhttpx>=0.25\n');
      const result = detectPythonAgent('/proj');
      expect(result.evidence).toContain('anthropic');
    });

    it('detects langchain-anthropic + langgraph in pyproject.toml dependencies', () => {
      existsSync.mockImplementation((p) => String(p).endsWith('pyproject.toml'));
      readFileSync.mockReturnValue(`
[project]
dependencies = [
  "langchain-anthropic>=0.1.0",
  "langgraph>=0.0.40",
]
`);
      const result = detectPythonAgent('/proj');
      expect(result.evidence).toEqual(expect.arrayContaining(['langchain-anthropic', 'langgraph']));
    });

    it('returns empty evidence when neither file mentions known SDK', () => {
      existsSync.mockImplementation((p) => String(p).endsWith('requirements.txt'));
      readFileSync.mockReturnValue('flask==3.0.0\n');
      const result = detectPythonAgent('/proj');
      expect(result.evidence).toEqual([]);
    });
  });

  // ── detectAgentRuntime ────────────────────────────────────

  describe('detectAgentRuntime', () => {
    it('returns kind=node when only package.json exists', () => {
      existsSync.mockImplementation((p) => String(p).endsWith('package.json'));
      readFileSync.mockReturnValue('{"dependencies":{"openai":"^4"}}');
      const result = detectAgentRuntime('/proj');
      expect(result.kind).toBe('node');
      expect(result.evidence).toContain('openai');
    });

    it('returns kind=python when only requirements.txt exists', () => {
      existsSync.mockImplementation((p) => String(p).endsWith('requirements.txt'));
      readFileSync.mockReturnValue('anthropic==0.30.0\n');
      const result = detectAgentRuntime('/proj');
      expect(result.kind).toBe('python');
    });

    it('returns kind=both when package.json AND pyproject.toml exist', () => {
      existsSync.mockImplementation((p) =>
        String(p).endsWith('package.json') || String(p).endsWith('pyproject.toml'),
      );
      readFileSync.mockImplementation((p) => {
        if (String(p).endsWith('package.json')) return '{"dependencies":{"openai":"^4"}}';
        return 'dependencies = ["anthropic>=0.30"]';
      });
      const result = detectAgentRuntime('/proj');
      expect(result.kind).toBe('both');
      expect(result.node.evidence).toContain('openai');
      expect(result.python.evidence).toContain('anthropic');
    });

    it('returns kind=null when nothing matches', () => {
      existsSync.mockReturnValue(false);
      expect(detectAgentRuntime('/proj').kind).toBeNull();
    });
  });
});
