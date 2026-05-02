import { describe, it, expect, vi, beforeEach } from 'vitest';

// node:fs is fully mocked. existsSync and readFileSync are reconfigured
// per-test to simulate which OC artifacts are present + what openclaw.json
// looks like. writeFileSync and rmSync are spies for assertions.
vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => '{}'),
  writeFileSync: vi.fn(),
  rmSync: vi.fn(),
}));

vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/mock/home'),
}));

vi.mock('node:path', () => ({
  join: vi.fn((...args) => args.join('/')),
}));

const { existsSync, readFileSync, writeFileSync, rmSync } = await import('node:fs');
const { runUninstall } = await import('../lib/uninstall.js');

beforeEach(() => {
  vi.clearAllMocks();
  existsSync.mockReturnValue(false);
  readFileSync.mockReturnValue('{}');
});

describe('runUninstall', () => {
  it('returns nothing-removed when no install artifacts exist', () => {
    const result = runUninstall();
    expect(result.components_removed).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(rmSync).not.toHaveBeenCalled();
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it('removes the router plugin directory when present', () => {
    existsSync.mockImplementation((p) =>
      String(p).endsWith('/robot-resources-router'),
    );
    const result = runUninstall();
    expect(rmSync).toHaveBeenCalledWith(
      '/mock/home/.openclaw/extensions/robot-resources-router',
      { recursive: true, force: true },
    );
    expect(result.components_removed).toContain('router_plugin_dir');
  });

  it('removes the scraper OC plugin directory when present', () => {
    existsSync.mockImplementation((p) =>
      String(p).endsWith('/robot-resources-scraper-oc-plugin'),
    );
    const result = runUninstall();
    expect(rmSync).toHaveBeenCalledWith(
      '/mock/home/.openclaw/extensions/robot-resources-scraper-oc-plugin',
      { recursive: true, force: true },
    );
    expect(result.components_removed).toContain('scraper_plugin_dir');
  });

  it('removes both plugin dirs when both are present', () => {
    existsSync.mockImplementation((p) => {
      const s = String(p);
      return s.endsWith('/robot-resources-router') ||
        s.endsWith('/robot-resources-scraper-oc-plugin');
    });
    const result = runUninstall();
    expect(rmSync).toHaveBeenCalledTimes(2);
    expect(result.components_removed).toEqual(
      expect.arrayContaining(['router_plugin_dir', 'scraper_plugin_dir']),
    );
  });

  it('captures rmSync failures per-component without aborting', () => {
    existsSync.mockImplementation((p) => {
      const s = String(p);
      return s.endsWith('/robot-resources-router') ||
        s.endsWith('/robot-resources-scraper-oc-plugin');
    });
    rmSync.mockImplementationOnce(() => { throw new Error('EBUSY'); });
    // second rmSync (scraper) succeeds.
    const result = runUninstall();
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].component).toBe('router_plugin_dir');
    expect(result.components_removed).toContain('scraper_plugin_dir');
  });

  it('strips plugins.entries entries from openclaw.json', () => {
    existsSync.mockImplementation((p) => String(p).endsWith('openclaw.json'));
    readFileSync.mockReturnValue(JSON.stringify({
      plugins: {
        entries: {
          'robot-resources-router': { enabled: true },
          'robot-resources-scraper-oc-plugin': { enabled: true },
          'some-other-plugin': { enabled: true },
        },
      },
    }));
    runUninstall();
    expect(writeFileSync).toHaveBeenCalledTimes(1);
    const written = JSON.parse(writeFileSync.mock.calls[0][1]);
    expect(written.plugins.entries['robot-resources-router']).toBeUndefined();
    expect(written.plugins.entries['robot-resources-scraper-oc-plugin']).toBeUndefined();
    expect(written.plugins.entries['some-other-plugin']).toEqual({ enabled: true });
  });

  it('strips both ids from plugins.allow array, leaves others intact', () => {
    existsSync.mockImplementation((p) => String(p).endsWith('openclaw.json'));
    readFileSync.mockReturnValue(JSON.stringify({
      plugins: {
        allow: [
          'robot-resources-router',
          'robot-resources-scraper-oc-plugin',
          'someone-elses-plugin',
        ],
      },
    }));
    runUninstall();
    const written = JSON.parse(writeFileSync.mock.calls[0][1]);
    expect(written.plugins.allow).toEqual(['someone-elses-plugin']);
  });

  it('strips robot-resources-scraper from mcp.servers', () => {
    existsSync.mockImplementation((p) => String(p).endsWith('openclaw.json'));
    readFileSync.mockReturnValue(JSON.stringify({
      mcp: {
        servers: {
          'robot-resources-scraper': { command: 'npx', args: [] },
          'unrelated-mcp': { command: 'foo' },
        },
      },
    }));
    runUninstall();
    const written = JSON.parse(writeFileSync.mock.calls[0][1]);
    expect(written.mcp.servers['robot-resources-scraper']).toBeUndefined();
    expect(written.mcp.servers['unrelated-mcp']).toEqual({ command: 'foo' });
  });

  it('records openclaw_config_entries in components_removed when something was stripped', () => {
    existsSync.mockImplementation((p) => String(p).endsWith('openclaw.json'));
    readFileSync.mockReturnValue(JSON.stringify({
      plugins: { entries: { 'robot-resources-router': { enabled: true } } },
    }));
    const result = runUninstall();
    expect(result.components_removed).toContain('openclaw_config_entries');
  });

  it('does NOT write openclaw.json when none of our entries were present (idempotent)', () => {
    existsSync.mockImplementation((p) => String(p).endsWith('openclaw.json'));
    readFileSync.mockReturnValue(JSON.stringify({
      plugins: { entries: { 'unrelated-plugin': { enabled: true } } },
    }));
    const result = runUninstall();
    expect(writeFileSync).not.toHaveBeenCalled();
    expect(result.components_removed).not.toContain('openclaw_config_entries');
  });

  it('captures malformed openclaw.json as an error without aborting', () => {
    existsSync.mockImplementation((p) => String(p).endsWith('openclaw.json'));
    readFileSync.mockReturnValue('not valid json{');
    const result = runUninstall();
    expect(result.errors.find((e) => e.component === 'openclaw_config_entries')).toBeTruthy();
  });

  it('preserves ~/.robot-resources/ when purge=false (default)', () => {
    existsSync.mockImplementation((p) => String(p).endsWith('/.robot-resources'));
    runUninstall({ purge: false });
    // Only false-positive case: the rr-dir existsSync call. rmSync should NOT touch it.
    expect(rmSync).not.toHaveBeenCalledWith(
      '/mock/home/.robot-resources',
      expect.anything(),
    );
  });

  it('removes ~/.robot-resources/ when purge=true', () => {
    existsSync.mockImplementation((p) => String(p).endsWith('/.robot-resources'));
    const result = runUninstall({ purge: true });
    expect(rmSync).toHaveBeenCalledWith(
      '/mock/home/.robot-resources',
      { recursive: true, force: true },
    );
    expect(result.components_removed).toContain('rr_config_dir');
  });

  it('purge=true is a no-op when ~/.robot-resources/ does not exist', () => {
    runUninstall({ purge: true });
    expect(rmSync).not.toHaveBeenCalledWith(
      '/mock/home/.robot-resources',
      expect.anything(),
    );
  });
});
