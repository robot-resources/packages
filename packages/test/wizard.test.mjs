import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(() => '{"version":"1.0.0"}'),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('node:path', () => ({
  join: vi.fn((...args) => args.join('/')),
}));

vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/mock/home'),
  hostname: vi.fn(() => 'test-host'),
  release: vi.fn(() => '24.0.0'),
}));

vi.mock('../lib/config.mjs', () => ({
  readConfig: vi.fn(),
  writeConfig: vi.fn(),
}));

vi.mock('../lib/detect.js', () => ({
  isOpenClawInstalled: vi.fn().mockReturnValue(false),
}));

vi.mock('../lib/machine-id.js', () => ({
  getOrCreateMachineId: vi.fn(() => 'mock-machine-uuid'),
}));

vi.mock('../lib/tool-config.js', () => ({
  configureToolRouting: vi.fn(() => []),
  registerScraperMcp: vi.fn(() => false),
  restartOpenClawGateway: vi.fn(() => Promise.resolve()),
}));

vi.mock('../lib/health-report.js', () => ({
  checkHealth: vi.fn(() => Promise.resolve({
    status: 'healthy',
    summary: 'All components healthy.',
  })),
}));

vi.mock('../lib/ui.js', () => ({
  header: vi.fn(),
  step: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  blank: vi.fn(),
  summary: vi.fn(),
}));

vi.mock('../lib/non-oc-wizard.js', () => ({
  runNonOcWizard: vi.fn(() => Promise.resolve()),
}));

const { writeFileSync } = await import('node:fs');
const { readConfig, writeConfig } = await import('../lib/config.mjs');
const { configureToolRouting, restartOpenClawGateway } = await import('../lib/tool-config.js');
const { isOpenClawInstalled } = await import('../lib/detect.js');
const { warn, info } = await import('../lib/ui.js');
const { runNonOcWizard } = await import('../lib/non-oc-wizard.js');
const { runWizard } = await import('../lib/wizard.js');

// Capture install_complete payloads sent via fetch.
function captureInstallPayload() {
  const installCalls = globalThis.fetch.mock.calls.filter(
    (c) => typeof c[0] === 'string' && c[0].includes('/v1/telemetry'),
  );
  for (const call of installCalls) {
    const body = call[1]?.body;
    if (!body) continue;
    const parsed = JSON.parse(body);
    if (parsed.event_type === 'install_complete') return parsed.payload;
  }
  return null;
}

describe('wizard (Option 4 — in-process server, no daemon-install path)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readConfig.mockReturnValue({ api_key: 'rr_live_test' });
    configureToolRouting.mockReturnValue([]);
    isOpenClawInstalled.mockReturnValue(false);
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
  });

  describe('signup', () => {
    it('calls /v1/auth/signup when no api_key on disk and RR_API_KEY unset', async () => {
      // Signup only runs past the non-OC early-exit guard. OC must be
      // present (or nonInteractive=true) for the wizard body to execute.
      isOpenClawInstalled.mockReturnValue(true);
      readConfig.mockReturnValue({});
      delete process.env.RR_API_KEY;
      globalThis.fetch = vi.fn().mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/v1/auth/signup')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ data: {
              api_key: 'rr_live_new',
              key_id: 'key-uuid',
              claim_url: 'https://robotresources.ai/claim?token=abc',
            }}),
          });
        }
        return Promise.resolve({ ok: true });
      });

      await runWizard({ nonInteractive: false });

      expect(writeConfig).toHaveBeenCalledWith(expect.objectContaining({
        api_key: 'rr_live_new',
        signup_source: 'auto',
      }));
    });

    it('skips signup when api_key already configured', async () => {
      isOpenClawInstalled.mockReturnValue(true);
      readConfig.mockReturnValue({ api_key: 'rr_live_existing' });
      await runWizard({ nonInteractive: false });
      expect(writeConfig).not.toHaveBeenCalled();
    });
  });

  describe('install_complete telemetry', () => {
    it('does NOT carry router/service/healthcheck fields (deleted with the daemon)', async () => {
      configureToolRouting.mockReturnValue([
        { name: 'OpenClaw', action: 'installed', configActivated: true },
      ]);
      isOpenClawInstalled.mockReturnValue(true);

      await runWizard({ nonInteractive: false });

      const payload = captureInstallPayload();
      expect(payload).not.toBeNull();
      expect(payload).not.toHaveProperty('router');
      expect(payload).not.toHaveProperty('service');
      expect(payload).not.toHaveProperty('serviceType');
      expect(payload).not.toHaveProperty('lingerEnabled');
      expect(payload).not.toHaveProperty('crontabFallback');
      expect(payload).not.toHaveProperty('python_source');
      expect(payload).not.toHaveProperty('health_check');
      expect(payload).not.toHaveProperty('routerError');
    });

    it('carries the new (Option 4) payload shape', async () => {
      configureToolRouting.mockReturnValue([
        { name: 'OpenClaw', action: 'installed', configActivated: true },
      ]);
      isOpenClawInstalled.mockReturnValue(true);

      await runWizard({ nonInteractive: false });

      const payload = captureInstallPayload();
      expect(payload).toEqual(expect.objectContaining({
        source: 'wizard',
        cli_version: expect.any(String),
        plugin_installed: true,
        scraper: expect.any(Boolean),
        platform: expect.any(String),
        os_release: expect.any(String),
        node_version: expect.any(String),
        install_duration_ms: expect.any(Number),
        openclaw_detected: true,
        openclaw_config_patched: true,
        scraper_mcp_registered: expect.any(Boolean),
      }));
    });
  });

  describe('OpenClaw absent', () => {
    it('hands off interactive non-OC runs to runNonOcWizard with no provisioning', async () => {
      isOpenClawInstalled.mockReturnValue(false);
      readConfig.mockReturnValue({});
      delete process.env.RR_API_KEY;
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });

      await runWizard({ nonInteractive: false });

      // The wizard body must NOT run: no signup, no telemetry, no status file.
      expect(writeConfig).not.toHaveBeenCalled();
      expect(globalThis.fetch).not.toHaveBeenCalled();
      const statusCall = writeFileSync.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('wizard-status.json'),
      );
      expect(statusCall).toBeFalsy();
      // Hand-off to the non-OC wizard happens with the right options.
      expect(runNonOcWizard).toHaveBeenCalledWith({ nonInteractive: false, target: null });
    });

    it('hands off non-interactive non-OC runs to runNonOcWizard (PR 8 behavior change)', async () => {
      // PR 8 unified the non-OC path: when OC is absent, ALL callers go to
      // runNonOcWizard regardless of nonInteractive. The pre-PR-8 escape
      // hatch (non-interactive + RR_API_KEY pre-set bypassed the early-exit
      // and ran the OC install path against a machine without OC) is gone.
      // That path no-op'd anyway since plugin install requires OC; the
      // non-oc-wizard print-and-exit is more useful for those users.
      isOpenClawInstalled.mockReturnValue(false);
      readConfig.mockReturnValue({ api_key: 'rr_live_preset' });
      configureToolRouting.mockReturnValue([]);

      await runWizard({ nonInteractive: true, target: 'langchain' });

      // No wizard body — runNonOcWizard handles it.
      expect(configureToolRouting).not.toHaveBeenCalled();
      expect(runNonOcWizard).toHaveBeenCalledWith({ nonInteractive: true, target: 'langchain' });
    });
  });

  describe('gateway restart', () => {
    it('restarts gateway when OC installed and plugin was just installed', async () => {
      isOpenClawInstalled.mockReturnValue(true);
      configureToolRouting.mockReturnValue([
        { name: 'OpenClaw', action: 'installed', configActivated: true },
      ]);
      await runWizard({ nonInteractive: false });
      expect(restartOpenClawGateway).toHaveBeenCalled();
    });

    it('skips gateway restart when OC not installed', async () => {
      isOpenClawInstalled.mockReturnValue(false);
      await runWizard({ nonInteractive: false });
      expect(restartOpenClawGateway).not.toHaveBeenCalled();
    });
  });

  describe('non-interactive human notification', () => {
    it('prints notification when plugin installed and nonInteractive', async () => {
      isOpenClawInstalled.mockReturnValue(true);
      configureToolRouting.mockReturnValue([
        { name: 'OpenClaw', action: 'installed', configActivated: true },
      ]);
      delete process.env.RR_API_KEY;
      await runWizard({ nonInteractive: true });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Notify your human'));
      expect(info).toHaveBeenCalledWith(expect.stringContaining('Router plugin installed'));
    });

    it('suppresses notification when RR_API_KEY pre-set (enterprise)', async () => {
      isOpenClawInstalled.mockReturnValue(true);
      configureToolRouting.mockReturnValue([
        { name: 'OpenClaw', action: 'installed', configActivated: true },
      ]);
      process.env.RR_API_KEY = 'preset';
      await runWizard({ nonInteractive: true });
      delete process.env.RR_API_KEY;
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('Notify your human'));
    });
  });

  describe('wizard-status.json', () => {
    it('writes wizard-status.json when something was installed', async () => {
      isOpenClawInstalled.mockReturnValue(true);
      configureToolRouting.mockReturnValue([
        { name: 'OpenClaw', action: 'installed', configActivated: true },
      ]);
      await runWizard({ nonInteractive: false });
      const statusCall = writeFileSync.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('wizard-status.json'),
      );
      expect(statusCall).toBeTruthy();
      const data = JSON.parse(statusCall[1]);
      expect(data).toEqual(expect.objectContaining({
        completed_at: expect.any(String),
        plugin: true,
      }));
      expect(data).not.toHaveProperty('router');
      expect(data).not.toHaveProperty('service');
    });
  });
});
