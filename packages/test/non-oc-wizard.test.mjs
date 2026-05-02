import { describe, it, expect, vi, beforeEach } from 'vitest';

// node:fs is stubbed per-test by overwriting the readFileSync return + existsSync.
vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => '{}'),
}));

vi.mock('node:path', () => ({
  join: vi.fn((...args) => args.join('/')),
}));

vi.mock('@inquirer/prompts', () => ({
  select: vi.fn(),
}));

vi.mock('../lib/detect.js', () => ({
  isClaudeCodeInstalled: vi.fn(() => false),
  isCursorInstalled: vi.fn(() => false),
}));

vi.mock('../lib/tool-config.js', () => ({
  configureClaudeCode: vi.fn(() => ({ action: 'configured' })),
  configureCursor: vi.fn(() => ({ action: 'configured' })),
}));

vi.mock('../lib/ui.js', () => ({
  header: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  blank: vi.fn(),
}));

vi.mock('../lib/config.mjs', () => ({
  readConfig: vi.fn(() => ({ api_key: 'rr_live_test' })),
}));

const { existsSync, readFileSync } = await import('node:fs');
const { select } = await import('@inquirer/prompts');
const { isClaudeCodeInstalled, isCursorInstalled } = await import('../lib/detect.js');
const { configureClaudeCode, configureCursor } = await import('../lib/tool-config.js');
const { info } = await import('../lib/ui.js');
const { readConfig } = await import('../lib/config.mjs');
const { runNonOcWizard, detectDefaultPath } = await import('../lib/non-oc-wizard.js');

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
  existsSync.mockReturnValue(false);
  isClaudeCodeInstalled.mockReturnValue(false);
  isCursorInstalled.mockReturnValue(false);
  readConfig.mockReturnValue({ api_key: 'rr_live_test' });
});

describe('detectDefaultPath', () => {
  it('returns "js" when cwd has package.json with langchain dep', () => {
    existsSync.mockImplementation((p) => String(p).endsWith('package.json'));
    readFileSync.mockReturnValue(JSON.stringify({ dependencies: { langchain: '^0.1.0' } }));
    expect(detectDefaultPath('/test')).toBe('js');
  });

  it('returns "js" for any package.json (generic JS project default)', () => {
    existsSync.mockImplementation((p) => String(p).endsWith('package.json'));
    readFileSync.mockReturnValue(JSON.stringify({ dependencies: {} }));
    expect(detectDefaultPath('/test')).toBe('js');
  });

  it('returns "python" when cwd has requirements.txt', () => {
    existsSync.mockImplementation((p) => String(p).endsWith('requirements.txt'));
    expect(detectDefaultPath('/test')).toBe('python');
  });

  it('returns "python" when cwd has pyproject.toml', () => {
    existsSync.mockImplementation((p) => String(p).endsWith('pyproject.toml'));
    expect(detectDefaultPath('/test')).toBe('python');
  });

  it('returns "mcp" when Cursor is installed and no project markers', () => {
    isCursorInstalled.mockReturnValue(true);
    expect(detectDefaultPath('/test')).toBe('mcp');
  });

  it('returns "mcp" when Claude Code is installed', () => {
    isClaudeCodeInstalled.mockReturnValue(true);
    expect(detectDefaultPath('/test')).toBe('mcp');
  });

  it('returns null when nothing matches', () => {
    expect(detectDefaultPath('/empty-dir')).toBeNull();
  });
});

describe('runNonOcWizard — --for=<target> direct routing', () => {
  it('runs the JS path when target=js', async () => {
    await runNonOcWizard({ nonInteractive: true, target: 'js' });
    expect(select).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.stringContaining('npm install @robot-resources/router'));
  });

  it('runs the JS path when target=langchain (alias)', async () => {
    await runNonOcWizard({ nonInteractive: true, target: 'langchain' });
    expect(info).toHaveBeenCalledWith(expect.stringContaining('npm install @robot-resources/router'));
  });

  it('runs the Python path when target=python (pip install + SDK + httpx fallback hint)', async () => {
    await runNonOcWizard({ nonInteractive: true, target: 'python' });
    expect(info).toHaveBeenCalledWith(expect.stringContaining('pip install robot-resources'));
    expect(info).toHaveBeenCalledWith(expect.stringContaining('from robot_resources.router import route'));
    // Must NOT recommend the deprecated robot-resources-router PyPI name.
    const calls = info.mock.calls.map((c) => c[0]).join('\n');
    expect(calls).not.toContain('pip install robot-resources-router');
    expect(calls).not.toContain('rr_router');
  });

  it('runs the MCP path when target=cursor and Cursor is installed', async () => {
    isCursorInstalled.mockReturnValue(true);
    await runNonOcWizard({ nonInteractive: true, target: 'mcp' });
    expect(configureCursor).toHaveBeenCalled();
  });

  it('runs the MCP path when target=claude-code (alias) and Claude Code is installed', async () => {
    isClaudeCodeInstalled.mockReturnValue(true);
    await runNonOcWizard({ nonInteractive: true, target: 'claude-code' });
    expect(configureClaudeCode).toHaveBeenCalled();
  });

  it('runs the docs path when target=docs', async () => {
    await runNonOcWizard({ nonInteractive: true, target: 'docs' });
    expect(info).toHaveBeenCalledWith(expect.stringContaining('https://robotresources.ai/docs'));
  });

  it('falls through to the install-OC hint when target is unknown', async () => {
    await runNonOcWizard({ nonInteractive: true, target: 'something-else' });
    // Unknown target → normalizeTarget returns null → non-interactive print-hint path.
    expect(info).toHaveBeenCalledWith(expect.stringContaining('--for=langchain'));
    expect(select).not.toHaveBeenCalled();
  });

  it('emits wizard_path_chosen telemetry after a target is run', async () => {
    await runNonOcWizard({ nonInteractive: true, target: 'js' });
    const calls = globalThis.fetch.mock.calls.filter((c) => typeof c[0] === 'string' && c[0].includes('/v1/telemetry'));
    expect(calls.length).toBe(1);
    const body = JSON.parse(calls[0][1].body);
    expect(body.event_type).toBe('wizard_path_chosen');
    expect(body.payload.path).toBe('js');
  });

  it('skips telemetry when no api_key is in config', async () => {
    readConfig.mockReturnValue({});
    await runNonOcWizard({ nonInteractive: true, target: 'js' });
    const calls = globalThis.fetch.mock.calls.filter((c) => typeof c[0] === 'string' && c[0].includes('/v1/telemetry'));
    expect(calls.length).toBe(0);
  });
});

describe('runNonOcWizard — non-interactive without --for=', () => {
  it('prints the --for= hint and exits without running a path', async () => {
    await runNonOcWizard({ nonInteractive: true, target: null });
    expect(select).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.stringContaining('--for=langchain'));
    expect(info).toHaveBeenCalledWith(expect.stringContaining('--for=python'));
  });

  it('emits wizard_path_chosen with path=noninteractive_no_target on the bare hint exit', async () => {
    await runNonOcWizard({ nonInteractive: true, target: null });
    const calls = globalThis.fetch.mock.calls.filter((c) => typeof c[0] === 'string' && c[0].includes('/v1/telemetry'));
    expect(calls.length).toBe(1);
    const body = JSON.parse(calls[0][1].body);
    expect(body.event_type).toBe('wizard_path_chosen');
    expect(body.payload.path).toBe('noninteractive_no_target');
  });

  it('skips the noninteractive_no_target telemetry when no api_key is in config', async () => {
    readConfig.mockReturnValue({});
    await runNonOcWizard({ nonInteractive: true, target: null });
    const calls = globalThis.fetch.mock.calls.filter((c) => typeof c[0] === 'string' && c[0].includes('/v1/telemetry'));
    expect(calls.length).toBe(0);
  });
});

describe('runNonOcWizard — interactive menu', () => {
  it('opens the prompt and runs the chosen path', async () => {
    select.mockResolvedValue('python');
    await runNonOcWizard({ nonInteractive: false, target: null });
    expect(select).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledWith(expect.stringContaining('pip install robot-resources'));
  });

  it('preselects "js" when cwd looks like a JS project', async () => {
    existsSync.mockImplementation((p) => String(p).endsWith('package.json'));
    readFileSync.mockReturnValue('{}');
    select.mockResolvedValue('js');
    await runNonOcWizard({ nonInteractive: false, target: null });
    const callArgs = select.mock.calls[0][0];
    expect(callArgs.default).toBe('js');
  });

  it('preselects "python" when cwd has requirements.txt', async () => {
    existsSync.mockImplementation((p) => String(p).endsWith('requirements.txt'));
    select.mockResolvedValue('python');
    await runNonOcWizard({ nonInteractive: false, target: null });
    expect(select.mock.calls[0][0].default).toBe('python');
  });

  it('preselects "mcp" when Cursor is installed and no project markers', async () => {
    isCursorInstalled.mockReturnValue(true);
    select.mockResolvedValue('mcp');
    await runNonOcWizard({ nonInteractive: false, target: null });
    expect(select.mock.calls[0][0].default).toBe('mcp');
  });

  it('emits wizard_path_chosen with path=aborted on Ctrl-C (ExitPromptError)', async () => {
    const exitErr = new Error('User force-closed');
    exitErr.name = 'ExitPromptError';
    select.mockRejectedValue(exitErr);
    await expect(runNonOcWizard({ nonInteractive: false, target: null })).resolves.toBeUndefined();
    const calls = globalThis.fetch.mock.calls.filter((c) => typeof c[0] === 'string' && c[0].includes('/v1/telemetry'));
    expect(calls.length).toBe(1);
    const body = JSON.parse(calls[0][1].body);
    expect(body.event_type).toBe('wizard_path_chosen');
    expect(body.payload.path).toBe('aborted');
  });

  it('also handles ABORT_ERR code on prompt abort with the same telemetry', async () => {
    const exitErr = new Error('aborted');
    exitErr.code = 'ABORT_ERR';
    select.mockRejectedValue(exitErr);
    await runNonOcWizard({ nonInteractive: false, target: null });
    const calls = globalThis.fetch.mock.calls.filter((c) => typeof c[0] === 'string' && c[0].includes('/v1/telemetry'));
    expect(JSON.parse(calls[0][1].body).payload.path).toBe('aborted');
  });

  it('emits wizard_path_chosen after the user picks an option', async () => {
    select.mockResolvedValue('docs');
    await runNonOcWizard({ nonInteractive: false, target: null });
    const calls = globalThis.fetch.mock.calls.filter((c) => typeof c[0] === 'string' && c[0].includes('/v1/telemetry'));
    expect(calls.length).toBe(1);
    expect(JSON.parse(calls[0][1].body).payload.path).toBe('docs');
  });
});
