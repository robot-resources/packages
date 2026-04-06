import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/detect.js', () => ({
  isOpenClawInstalled: vi.fn(),
  isOpenClawPluginInstalled: vi.fn(),
  getOpenClawAuthMode: vi.fn().mockReturnValue('apikey'),
}));

function createMockProc(exitCode = 0) {
  const listeners = {};
  const proc = {
    on: vi.fn((event, cb) => { listeners[event] = cb; }),
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    kill: vi.fn(),
  };
  setTimeout(() => listeners.close?.(exitCode), 0);
  return proc;
}

let spawnExitCode = 0;
let spawnShouldError = false;

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(() => {
    if (spawnShouldError) {
      const listeners = {};
      const proc = {
        on: vi.fn((event, cb) => { listeners[event] = cb; }),
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        kill: vi.fn(),
      };
      setTimeout(() => listeners.error?.(new Error('spawn failed')), 0);
      return proc;
    }
    return createMockProc(spawnExitCode);
  }),
}));

let copyFileShouldThrow = false;
let requireResolveShouldThrow = false;

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
  copyFileSync: vi.fn(() => {
    if (copyFileShouldThrow) throw new Error('EACCES: permission denied');
  }),
  mkdirSync: vi.fn(),
}));

const mockResolve = vi.fn(() => {
  if (requireResolveShouldThrow) throw new Error('Cannot find module');
  return '/mock/node_modules/@robot-resources/openclaw-plugin/package.json';
});
const mockRequire = Object.assign(vi.fn(), { resolve: mockResolve });

vi.mock('node:module', () => ({
  createRequire: vi.fn(() => mockRequire),
}));

const { isOpenClawInstalled, isOpenClawPluginInstalled, getOpenClawAuthMode } = await import('../lib/detect.js');
const { spawn: spawnMock } = await import('node:child_process');
const { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } = await import('node:fs');
const { stripJson5, configureOpenClaw, configureToolRouting, registerScraperMcp, restartOpenClawGateway } =
  await import('../lib/tool-config.js');

describe('tool-config', () => {
  const MOCK_OC_CONFIG = JSON.stringify({
    agents: {
      defaults: {
        model: { primary: 'anthropic/claude-sonnet-4-20250514' },
      },
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    spawnExitCode = 0;
    spawnShouldError = false;
    copyFileShouldThrow = false;
    requireResolveShouldThrow = false;
    existsSync.mockReturnValue(true);
    isOpenClawPluginInstalled.mockReturnValue(false);
    getOpenClawAuthMode.mockReturnValue('apikey');
    // Default: openclaw.json readable with Anthropic as primary model
    readFileSync.mockReturnValue(MOCK_OC_CONFIG);
  });

  // ── stripJson5 ──────────────────────────────────────────────

  describe('stripJson5', () => {
    it('strips single-line comments', () => {
      const input = '{\n  "a": 1 // comment\n}';
      expect(JSON.parse(stripJson5(input))).toEqual({ a: 1 });
    });

    it('strips multi-line comments', () => {
      const input = '{\n  /* block\n  comment */\n  "a": 1\n}';
      expect(JSON.parse(stripJson5(input))).toEqual({ a: 1 });
    });

    it('strips trailing commas before }', () => {
      const input = '{ "a": 1, "b": 2, }';
      expect(JSON.parse(stripJson5(input))).toEqual({ a: 1, b: 2 });
    });

    it('strips trailing commas before ]', () => {
      const input = '{ "a": [1, 2, 3, ] }';
      expect(JSON.parse(stripJson5(input))).toEqual({ a: [1, 2, 3] });
    });

    it('handles all JSON5 features together', () => {
      const input = `{
        // OpenClaw config
        "models": {
          /* provider settings */
          "mode": "merge",
          "providers": {
            "anthropic": {
              "apiKey": "sk-ant-xxx",
            },
          },
        },
      }`;
      const parsed = JSON.parse(stripJson5(input));
      expect(parsed.models.mode).toBe('merge');
      expect(parsed.models.providers.anthropic.apiKey).toBe('sk-ant-xxx');
    });

    it('preserves // inside quoted strings (URLs)', () => {
      const input = '{ "url": "http://localhost:3838/v1" }';
      expect(JSON.parse(stripJson5(input))).toEqual({ url: 'http://localhost:3838/v1' });
    });

    it('preserves URLs while stripping comments on same line', () => {
      const input = '{ "url": "http://localhost:3838/v1" } // my config';
      expect(JSON.parse(stripJson5(input))).toEqual({ url: 'http://localhost:3838/v1' });
    });

    it('passes through valid JSON unchanged', () => {
      const input = '{"a": 1, "b": [2, 3]}';
      expect(JSON.parse(stripJson5(input))).toEqual({ a: 1, b: [2, 3] });
    });
  });

  // ── configureOpenClaw ───────────────────────────────────────

  describe('configureOpenClaw', () => {
    it('copies plugin files to extensions directory', () => {
      configureOpenClaw();

      expect(mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('.openclaw/extensions/openclaw-plugin'),
        { recursive: true },
      );
      expect(copyFileSync).toHaveBeenCalledTimes(3);
      expect(copyFileSync).toHaveBeenCalledWith(
        expect.stringContaining('index.js'),
        expect.stringContaining('.openclaw/extensions/openclaw-plugin/index.js'),
      );
      expect(copyFileSync).toHaveBeenCalledWith(
        expect.stringContaining('openclaw.plugin.json'),
        expect.stringContaining('.openclaw/extensions/openclaw-plugin/openclaw.plugin.json'),
      );
      expect(copyFileSync).toHaveBeenCalledWith(
        expect.stringContaining('package.json'),
        expect.stringContaining('.openclaw/extensions/openclaw-plugin/package.json'),
      );
    });

    it('creates extensions directory with recursive flag', () => {
      configureOpenClaw();

      expect(mkdirSync).toHaveBeenCalledWith(
        expect.any(String),
        { recursive: true },
      );
    });

    it('returns installed action on success', () => {
      const result = configureOpenClaw();

      expect(result.name).toBe('OpenClaw');
      expect(result.action).toBe('installed');
      expect(result.gatewayRestarted).toBeUndefined();
    });

    it('returns already_configured when plugin exists', () => {
      isOpenClawPluginInstalled.mockReturnValue(true);

      const result = configureOpenClaw();

      expect(result.action).toBe('already_configured');
      expect(copyFileSync).not.toHaveBeenCalled();
    });

    it('does not reinstall when already configured', () => {
      isOpenClawPluginInstalled.mockReturnValue(true);

      configureOpenClaw();

      expect(copyFileSync).not.toHaveBeenCalled();
      expect(mkdirSync).not.toHaveBeenCalled();
    });

    it('falls back to instructions when plugin not in node_modules', () => {
      requireResolveShouldThrow = true;

      const result = configureOpenClaw();

      expect(result.action).toBe('instructions');
      expect(result.instructions.some((i) =>
        i.includes('openclaw plugins install'),
      )).toBe(true);
    });

    it('falls back to instructions when file copy fails', () => {
      copyFileShouldThrow = true;

      const result = configureOpenClaw();

      expect(result.action).toBe('instructions');
    });

    it('instructions include package name for manual install', () => {
      requireResolveShouldThrow = true;

      const result = configureOpenClaw();

      expect(result.instructions.some((i) =>
        i.includes('@robot-resources/openclaw-plugin'),
      )).toBe(true);
    });

    it('includes authMode in result', () => {
      getOpenClawAuthMode.mockReturnValue('apikey');
      const result = configureOpenClaw();
      expect(result.authMode).toBe('apikey');
    });

    it('includes note for subscription auth mode on install', () => {
      getOpenClawAuthMode.mockReturnValue('subscription');
      const result = configureOpenClaw();
      expect(result.action).toBe('installed');
      expect(result.note).toMatch(/subscription.*OAuth/i);
    });

    it('no note for apikey auth mode on install', () => {
      getOpenClawAuthMode.mockReturnValue('apikey');
      const result = configureOpenClaw();
      expect(result.action).toBe('installed');
      expect(result.note).toBeUndefined();
    });

    it('adds openclaw-plugin to plugins.allow on install', () => {
      const result = configureOpenClaw();
      expect(result.configActivated).toBe(true);
      expect(writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('openclaw.json'),
        expect.stringContaining('openclaw-plugin'),
        'utf-8',
      );
    });

    it('skips trust when plugin already in plugins.allow', () => {
      readFileSync.mockReturnValue(JSON.stringify({
        plugins: { entries: { 'openclaw-plugin': { enabled: true } }, allow: ['openclaw-plugin'] },
        mcp: { servers: { 'robot-resources-scraper': {} } },
      }));

      const result = configureOpenClaw();
      expect(result.configActivated).toBe(false);
    });

    it('creates config when openclaw.json is missing', () => {
      existsSync.mockReturnValue(false);

      const result = configureOpenClaw();
      expect(result.action).toBe('installed');
      expect(result.configActivated).toBe(true);
      expect(mkdirSync).toHaveBeenCalled();
    });

    it('warns about subscription in fallback instructions', () => {
      getOpenClawAuthMode.mockReturnValue('subscription');
      requireResolveShouldThrow = true;

      const result = configureOpenClaw();
      expect(result.action).toBe('instructions');
      expect(result.authMode).toBe('subscription');
      expect(result.instructions.some((i) =>
        i.includes('Subscription mode detected'),
      )).toBe(true);
    });

    it('no subscription warning in fallback for apikey mode', () => {
      getOpenClawAuthMode.mockReturnValue('apikey');
      requireResolveShouldThrow = true;

      const result = configureOpenClaw();
      expect(result.instructions.some((i) =>
        i.includes('Subscription mode detected'),
      )).toBe(false);
    });
  });

  // ── restartOpenClawGateway ─────────────────────────────────

  describe('restartOpenClawGateway', () => {
    it('spawns openclaw gateway restart', async () => {
      await restartOpenClawGateway();

      expect(spawnMock).toHaveBeenCalledWith(
        'openclaw',
        ['gateway', 'restart'],
        expect.objectContaining({ timeout: 15_000 }),
      );
    });

    it('rejects on non-zero exit code', async () => {
      spawnExitCode = 1;

      await expect(restartOpenClawGateway()).rejects.toThrow();
    });

    it('rejects on spawn error', async () => {
      spawnShouldError = true;

      await expect(restartOpenClawGateway()).rejects.toThrow();
    });
  });

  // ── configureToolRouting ────────────────────────────────────

  describe('configureToolRouting', () => {
    it('skips when OpenClaw not installed', () => {
      isOpenClawInstalled.mockReturnValue(false);

      const results = configureToolRouting();
      expect(results).toEqual([]);
    });

    it('installs plugin when OpenClaw is installed', () => {
      isOpenClawInstalled.mockReturnValue(true);

      const results = configureToolRouting();
      expect(results).toHaveLength(1);
      expect(results[0].action).toBe('installed');
    });

    it('reports already_configured when plugin exists', () => {
      isOpenClawInstalled.mockReturnValue(true);
      isOpenClawPluginInstalled.mockReturnValue(true);

      const results = configureToolRouting();
      expect(results).toHaveLength(1);
      expect(results[0].action).toBe('already_configured');
    });

    it('falls back gracefully on install failure', () => {
      isOpenClawInstalled.mockReturnValue(true);
      requireResolveShouldThrow = true;

      const results = configureToolRouting();
      expect(results).toHaveLength(1);
      expect(results[0].action).toBe('instructions');
    });
  });

  // ── detect: isOpenClawPluginInstalled ───────────────────────

  describe('isOpenClawPluginInstalled', () => {
    it('is imported and callable', () => {
      expect(typeof isOpenClawPluginInstalled).toBe('function');
    });
  });

  // ── registerScraperMcp ─────────────────────────────────────

  describe('registerScraperMcp', () => {
    const OC_CONFIG_NO_SCRAPER = JSON.stringify({
      mcp: { servers: {} },
    });

    const OC_CONFIG_WITH_SCRAPER = JSON.stringify({
      mcp: { servers: { 'robot-resources-scraper': { command: 'npx', args: [] } } },
    });

    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('registers scraper MCP when not already present', () => {
      readFileSync.mockReturnValue(OC_CONFIG_NO_SCRAPER);

      const result = registerScraperMcp();

      expect(result).toBe(true);
      expect(writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('openclaw.json'),
        expect.stringContaining('robot-resources-scraper'),
        'utf-8',
      );
    });

    it('returns false when scraper already registered', () => {
      readFileSync.mockReturnValue(OC_CONFIG_WITH_SCRAPER);

      const result = registerScraperMcp();

      expect(result).toBe(false);
      expect(writeFileSync).not.toHaveBeenCalled();
    });

    it('creates config and registers scraper when config file is missing', () => {
      existsSync.mockReturnValue(false);

      const result = registerScraperMcp();

      expect(result).toBe(true);
      expect(mkdirSync).toHaveBeenCalled();
      // writeFileSync called twice: once to create minimal config, once to write scraper entry
      expect(writeFileSync).toHaveBeenCalled();
      const lastWrite = JSON.parse(writeFileSync.mock.calls[writeFileSync.mock.calls.length - 1][1]);
      expect(lastWrite.mcp.servers['robot-resources-scraper']).toBeDefined();
    });

    it('returns false when config is malformed JSON', () => {
      readFileSync.mockReturnValue('not valid json {{{');

      const result = registerScraperMcp();

      expect(result).toBe(false);
    });

    it('creates mcp.servers path if missing', () => {
      readFileSync.mockReturnValue(JSON.stringify({}));

      const result = registerScraperMcp();

      expect(result).toBe(true);
      const written = JSON.parse(writeFileSync.mock.calls[0][1]);
      expect(written.mcp.servers['robot-resources-scraper']).toBeDefined();
    });
  });
});
