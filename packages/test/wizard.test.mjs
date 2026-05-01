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

// Capture telemetry payloads sent via fetch, by event_type.
function captureTelemetryPayload(eventType) {
  const calls = globalThis.fetch.mock.calls.filter(
    (c) => typeof c[0] === 'string' && c[0].includes('/v1/telemetry'),
  );
  for (const call of calls) {
    const body = call[1]?.body;
    if (!body) continue;
    const parsed = JSON.parse(body);
    if (parsed.event_type === eventType) return parsed.payload;
  }
  return null;
}

const captureInstallPayload = () => captureTelemetryPayload('install_complete');
const captureWizardStartedPayload = () => captureTelemetryPayload('wizard_started');

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
    it('provisions api_key + fires wizard_started before handing off to runNonOcWizard', async () => {
      // Closes the funnel blind spot: every non-OpenClaw install used to be
      // invisible (no api_keys row, no wizard_started, no agent_signup_meta)
      // because the early-exit ran before Step 0 + the wizard_started emit.
      isOpenClawInstalled.mockReturnValue(false);
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

      // Signup writes the new api_key to config.
      expect(writeConfig).toHaveBeenCalledWith(expect.objectContaining({
        api_key: 'rr_live_new',
        signup_source: 'auto',
      }));

      // wizard_started fires with openclaw_detected: false so the funnel
      // can be segmented OC vs non-OC.
      const wizardStarted = captureWizardStartedPayload();
      expect(wizardStarted).toEqual(expect.objectContaining({
        openclaw_detected: false,
        auth_method: 'auto',
        non_interactive: false,
      }));

      // OC-only telemetry (install_complete) is NOT sent on the non-OC path.
      expect(captureInstallPayload()).toBeNull();

      // Status file is NOT written (nothing was actually installed locally).
      const statusCall = writeFileSync.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('wizard-status.json'),
      );
      expect(statusCall).toBeFalsy();

      // Hand-off to the non-OC wizard still happens with the right options.
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

  describe('wizard_started telemetry', () => {
    it('tags openclaw_detected: true when OpenClaw is present', async () => {
      isOpenClawInstalled.mockReturnValue(true);
      readConfig.mockReturnValue({ api_key: 'rr_live_existing' });
      configureToolRouting.mockReturnValue([
        { name: 'OpenClaw', action: 'installed', configActivated: true },
      ]);

      await runWizard({ nonInteractive: false });

      const payload = captureWizardStartedPayload();
      expect(payload).toEqual(expect.objectContaining({
        openclaw_detected: true,
        cli_version: expect.any(String),
        auth_method: 'config',
      }));
    });

    it('does not fire when signup fails (results.auth stays false)', async () => {
      isOpenClawInstalled.mockReturnValue(false);
      readConfig.mockReturnValue({});
      delete process.env.RR_API_KEY;
      // Signup returns non-ok → results.auth never flips, wizard_started
      // is suppressed (no api_key to authenticate the telemetry POST anyway).
      globalThis.fetch = vi.fn().mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/v1/auth/signup')) {
          return Promise.resolve({ ok: false });
        }
        return Promise.resolve({ ok: true });
      });

      await runWizard({ nonInteractive: false });

      expect(captureWizardStartedPayload()).toBeNull();
      // Hand-off to non-OC wizard still happens — the install path is
      // independent of telemetry success.
      expect(runNonOcWizard).toHaveBeenCalled();
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
