import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';

vi.mock('../lib/detect.js', () => ({
  isOpenClawInstalled: vi.fn(),
  isOpenClawPluginInstalled: vi.fn(),
  isScraperOcPluginInstalled: vi.fn(),
  getOpenClawAuthMode: vi.fn().mockReturnValue('apikey'),
  isClaudeCodeInstalled: vi.fn(),
  isCursorInstalled: vi.fn(),
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
  cpSync: vi.fn(),
  rmSync: vi.fn(),
}));

const mockResolve = vi.fn(() => {
  if (requireResolveShouldThrow) throw new Error('Cannot find module');
  return '/mock/node_modules/@robot-resources/robot-resources-router/package.json';
});
const mockRequire = Object.assign(vi.fn(), { resolve: mockResolve });

vi.mock('node:module', () => ({
  createRequire: vi.fn(() => mockRequire),
}));

const { isOpenClawInstalled, isOpenClawPluginInstalled, isScraperOcPluginInstalled, getOpenClawAuthMode, isClaudeCodeInstalled, isCursorInstalled } = await import('../lib/detect.js');
const { spawn: spawnMock } = await import('node:child_process');
const { readFileSync, writeFileSync, copyFileSync, cpSync, rmSync, mkdirSync, existsSync } = await import('node:fs');
const { stripJson5, configureOpenClaw, configureClaudeCode, configureCursor, configureToolRouting, registerScraperMcp, restartOpenClawGateway } =
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
    isScraperOcPluginInstalled.mockReturnValue(false);
    isClaudeCodeInstalled.mockReturnValue(false);
    isCursorInstalled.mockReturnValue(false);
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
        expect.stringContaining(join('.openclaw', 'extensions', 'robot-resources-router')),
        { recursive: true },
      );
      // 6 calls: 3 files (index.js, openclaw.plugin.json, package.json) per
      // plugin, copied for both router + scraper-oc-plugin.
      expect(copyFileSync).toHaveBeenCalledTimes(6);
      expect(copyFileSync).toHaveBeenCalledWith(
        expect.stringContaining('index.js'),
        expect.stringContaining(join('.openclaw', 'extensions', 'robot-resources-router', 'index.js')),
      );
      expect(copyFileSync).toHaveBeenCalledWith(
        expect.stringContaining('openclaw.plugin.json'),
        expect.stringContaining(join('.openclaw', 'extensions', 'robot-resources-router', 'openclaw.plugin.json')),
      );
      expect(copyFileSync).toHaveBeenCalledWith(
        expect.stringContaining('package.json'),
        expect.stringContaining(join('.openclaw', 'extensions', 'robot-resources-router', 'package.json')),
      );
      expect(copyFileSync).toHaveBeenCalledWith(
        expect.stringContaining('index.js'),
        expect.stringContaining(join('.openclaw', 'extensions', 'robot-resources-scraper-oc-plugin', 'index.js')),
      );
      expect(copyFileSync).toHaveBeenCalledWith(
        expect.stringContaining('openclaw.plugin.json'),
        expect.stringContaining(join('.openclaw', 'extensions', 'robot-resources-scraper-oc-plugin', 'openclaw.plugin.json')),
      );
      expect(copyFileSync).toHaveBeenCalledWith(
        expect.stringContaining('package.json'),
        expect.stringContaining(join('.openclaw', 'extensions', 'robot-resources-scraper-oc-plugin', 'package.json')),
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

    it('returns already_configured when both plugins exist', () => {
      isOpenClawPluginInstalled.mockReturnValue(true);
      isScraperOcPluginInstalled.mockReturnValue(true);

      const result = configureOpenClaw();

      expect(result.action).toBe('already_configured');
      expect(copyFileSync).not.toHaveBeenCalled();
    });

    it('does not reinstall when both plugins already configured', () => {
      isOpenClawPluginInstalled.mockReturnValue(true);
      isScraperOcPluginInstalled.mockReturnValue(true);

      configureOpenClaw();

      expect(copyFileSync).not.toHaveBeenCalled();
      expect(mkdirSync).not.toHaveBeenCalled();
    });

    it('installs only the missing plugin when one is already present', () => {
      // Router already installed; scraper-oc-plugin missing.
      isOpenClawPluginInstalled.mockReturnValue(true);
      isScraperOcPluginInstalled.mockReturnValue(false);

      const result = configureOpenClaw();

      expect(result.action).toBe('installed');
      // copyFileSync should fire only for the scraper plugin's three files
      // (index.js, openclaw.plugin.json, package.json), not the router's.
      // Total = 3 (scraper-oc-plugin only).
      expect(copyFileSync).toHaveBeenCalledTimes(3);
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
        i.includes('@robot-resources/router'),
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

    it('adds robot-resources-router to plugins.allow on install', () => {
      const result = configureOpenClaw();
      expect(result.configActivated).toBe(true);
      expect(writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('openclaw.json'),
        expect.stringContaining('robot-resources-router'),
        'utf-8',
      );
    });

    it('skips trust when both plugins already in plugins.allow', () => {
      readFileSync.mockReturnValue(JSON.stringify({
        plugins: {
          entries: {
            'robot-resources-router': { enabled: true },
            'robot-resources-scraper-oc-plugin': { enabled: true },
          },
          allow: ['robot-resources-router', 'robot-resources-scraper-oc-plugin'],
        },
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
    it('returns manual instructions when no tools detected', () => {
      isOpenClawInstalled.mockReturnValue(false);

      const results = configureToolRouting();
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Manual Configuration');
      expect(results[0].action).toBe('instructions');
      expect(results[0].instructions.some(l => l.includes('OPENAI_BASE_URL'))).toBe(true);
      expect(results[0].instructions.some(l => l.includes('ANTHROPIC_BASE_URL'))).toBe(true);
      // Gemini guidance present (no GOOGLE_API_BASE — that env var isn't real
      // and the router has no native Google endpoints; route via OpenAI-compat).
      expect(results[0].instructions.some(l => /gemini/i.test(l))).toBe(true);
    });

    it('Anthropic base_url has NO /v1 suffix (regression: SDK appends /v1/messages)', () => {
      isOpenClawInstalled.mockReturnValue(false);
      const results = configureToolRouting();
      const anthropicLine = results[0].instructions.find(l =>
        l.includes('ANTHROPIC_BASE_URL=')
      );
      expect(anthropicLine).toBeTruthy();
      expect(anthropicLine).not.toMatch(/ANTHROPIC_BASE_URL=http:\/\/localhost:3838\/v1/);
    });

    it('installs plugin when OpenClaw is installed', () => {
      isOpenClawInstalled.mockReturnValue(true);

      const results = configureToolRouting();
      expect(results).toHaveLength(1);
      expect(results[0].action).toBe('installed');
    });

    it('copies the plugin lib/ directory alongside the top-level files (regression: plugin 0.5.5 shim)', () => {
      // The plugin's index.js is a thin shim that imports ./lib/plugin-core.js
      // and friends. Prior to this fix, installPluginFiles copied only the
      // three top-level files, leaving the plugin unable to load on any
      // fresh 0.5.5/0.5.6 install with MODULE_NOT_FOUND.
      isOpenClawInstalled.mockReturnValue(true);

      configureToolRouting();

      // Top-level files still copied
      expect(copyFileSync).toHaveBeenCalledWith(
        expect.stringContaining(join('robot-resources-router', 'index.js')),
        expect.stringContaining(join('.openclaw', 'extensions', 'robot-resources-router', 'index.js')),
      );

      // lib/ directory copied recursively, after clearing any previous version
      expect(rmSync).toHaveBeenCalledWith(
        expect.stringContaining(join('.openclaw', 'extensions', 'robot-resources-router', 'lib')),
        expect.objectContaining({ recursive: true, force: true }),
      );
      expect(cpSync).toHaveBeenCalledWith(
        expect.stringContaining(join('robot-resources-router', 'lib')),
        expect.stringContaining(join('.openclaw', 'extensions', 'robot-resources-router', 'lib')),
        expect.objectContaining({ recursive: true }),
      );
    });

    it('skips lib/ copy when plugin has no lib directory (pre-0.5.5 compatibility)', () => {
      isOpenClawInstalled.mockReturnValue(true);
      // Override the default beforeEach existsSync=true for both lib probes
      // (router and scraper-oc-plugin). Test asserts neither cpSync fires when
      // neither plugin's source has a lib/ directory.
      existsSync.mockImplementation((p) => {
        const s = String(p);
        if (s.endsWith(join('robot-resources-router', 'lib'))) return false;
        if (s.endsWith(join('oc-plugin', 'lib'))) return false;
        return true;
      });

      configureToolRouting();

      expect(cpSync).not.toHaveBeenCalled();
    });

    it('reports already_configured when both plugins exist', () => {
      isOpenClawInstalled.mockReturnValue(true);
      isOpenClawPluginInstalled.mockReturnValue(true);
      isScraperOcPluginInstalled.mockReturnValue(true);

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

    it('configures Claude Code when detected', () => {
      isClaudeCodeInstalled.mockReturnValue(true);

      const results = configureToolRouting();
      expect(results.some(r => r.name === 'Claude Code')).toBe(true);
    });

    it('configures Cursor when detected', () => {
      isCursorInstalled.mockReturnValue(true);

      const results = configureToolRouting();
      expect(results.some(r => r.name === 'Cursor')).toBe(true);
    });

    it('configures multiple tools when all detected', () => {
      isOpenClawInstalled.mockReturnValue(true);
      isClaudeCodeInstalled.mockReturnValue(true);
      isCursorInstalled.mockReturnValue(true);

      const results = configureToolRouting();
      expect(results).toHaveLength(3);
      expect(results.map(r => r.name)).toEqual(['OpenClaw', 'Claude Code', 'Cursor']);
    });

    it('does not show manual instructions when at least one tool detected', () => {
      isClaudeCodeInstalled.mockReturnValue(true);

      const results = configureToolRouting();
      expect(results.some(r => r.name === 'Manual Configuration')).toBe(false);
    });
  });

  // ── configureClaudeCode ─────────────────────────────────────

  describe('configureClaudeCode', () => {
    it('writes MCP server entry to settings.json', () => {
      readFileSync.mockReturnValue(JSON.stringify({}));

      const result = configureClaudeCode();

      expect(result.name).toBe('Claude Code');
      expect(result.action).toBe('configured');
      expect(writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining(join('.claude', 'settings.json')),
        expect.stringContaining('robot-resources-router'),
        'utf-8',
      );
    });

    it('returns already_configured when entry exists', () => {
      readFileSync.mockReturnValue(JSON.stringify({
        mcpServers: { 'robot-resources-router': { command: 'npx', args: [] } },
      }));

      const result = configureClaudeCode();

      expect(result.action).toBe('already_configured');
      expect(writeFileSync).not.toHaveBeenCalled();
    });

    it('preserves existing settings when adding entry', () => {
      readFileSync.mockReturnValue(JSON.stringify({
        theme: 'dark',
        mcpServers: { 'other-server': { command: 'node', args: ['server.js'] } },
      }));

      configureClaudeCode();

      const written = JSON.parse(writeFileSync.mock.calls[0][1]);
      expect(written.theme).toBe('dark');
      expect(written.mcpServers['other-server']).toBeDefined();
      expect(written.mcpServers['robot-resources-router']).toBeDefined();
    });

    it('creates mcpServers key when missing', () => {
      readFileSync.mockReturnValue(JSON.stringify({ theme: 'dark' }));

      configureClaudeCode();

      const written = JSON.parse(writeFileSync.mock.calls[0][1]);
      expect(written.mcpServers['robot-resources-router']).toBeDefined();
    });

    it('creates config from scratch when file does not exist', () => {
      existsSync.mockReturnValue(false);

      const result = configureClaudeCode();

      expect(result.action).toBe('configured');
    });

    it('falls back to instructions on write error', () => {
      readFileSync.mockImplementation(() => { throw new Error('EACCES'); });

      const result = configureClaudeCode();

      expect(result.action).toBe('instructions');
      expect(result.instructions.some(l => l.includes('~/.claude/settings.json'))).toBe(true);
    });
  });

  // ── configureCursor ─────────────────────────────────────────

  describe('configureCursor', () => {
    it('writes MCP server entry to mcp.json', () => {
      readFileSync.mockReturnValue(JSON.stringify({}));

      const result = configureCursor();

      expect(result.name).toBe('Cursor');
      expect(result.action).toBe('configured');
      expect(writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining(join('.cursor', 'mcp.json')),
        expect.stringContaining('robot-resources-router'),
        'utf-8',
      );
    });

    it('returns already_configured when entry exists', () => {
      readFileSync.mockReturnValue(JSON.stringify({
        mcpServers: { 'robot-resources-router': { command: 'npx', args: [] } },
      }));

      const result = configureCursor();

      expect(result.action).toBe('already_configured');
      expect(writeFileSync).not.toHaveBeenCalled();
    });

    it('preserves existing config when adding entry', () => {
      readFileSync.mockReturnValue(JSON.stringify({
        mcpServers: { 'other-server': { command: 'node', args: ['server.js'] } },
      }));

      configureCursor();

      const written = JSON.parse(writeFileSync.mock.calls[0][1]);
      expect(written.mcpServers['other-server']).toBeDefined();
      expect(written.mcpServers['robot-resources-router']).toBeDefined();
    });

    it('falls back to instructions on write error', () => {
      readFileSync.mockImplementation(() => { throw new Error('EACCES'); });

      const result = configureCursor();

      expect(result.action).toBe('instructions');
      expect(result.instructions.some(l => l.includes('~/.cursor/mcp.json'))).toBe(true);
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
