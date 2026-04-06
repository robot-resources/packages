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
}));

vi.mock('@robot-resources/cli-core/config.mjs', () => ({
  readConfig: vi.fn(),
  writeConfig: vi.fn(),
  readProviderKeys: vi.fn(),
  writeProviderKeys: vi.fn(),
}));

vi.mock('../lib/detect.js', () => ({
  findPython: vi.fn(),
  isPortAvailable: vi.fn(),
  isOpenClawInstalled: vi.fn().mockReturnValue(false),
  isHeadless: vi.fn().mockReturnValue(false),
}));

vi.mock('../lib/machine-id.js', () => ({
  getOrCreateMachineId: vi.fn(() => 'mock-machine-uuid'),
}));

vi.mock('../lib/python-bridge.js', () => ({
  setupRouter: vi.fn(),
  isRouterInstalled: vi.fn(),
  getVenvPythonPath: vi.fn(),
}));

vi.mock('../lib/service.js', () => ({
  installService: vi.fn(),
  isServiceRunning: vi.fn(),
  isServiceInstalled: vi.fn(),
  getMissingProviderKeys: vi.fn(),
}));

vi.mock('../lib/tool-config.js', () => ({
  configureToolRouting: vi.fn(() => []),
  registerScraperMcp: vi.fn(() => false),
  restartOpenClawGateway: vi.fn(() => Promise.resolve()),
}));

vi.mock('../lib/health-report.js', () => ({
  checkHealth: vi.fn(() => Promise.resolve({
    status: 'healthy',
    components: {
      router: { healthy: true, detail: 'running (v1.0.0)' },
      scraper: { healthy: true, detail: 'MCP registered' },
      platform: { healthy: true, detail: 'reachable' },
      mcp: { healthy: true, detail: 'plugin registered' },
    },
    summary: 'All 4 components healthy.',
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

const { checkHealth } = await import('../lib/health-report.js');
const { readFileSync, writeFileSync, mkdirSync } = await import('node:fs');
const { readConfig, writeConfig, readProviderKeys } = await import('@robot-resources/cli-core/config.mjs');
const { isRouterInstalled, getVenvPythonPath } = await import('../lib/python-bridge.js');
const { isServiceRunning, getMissingProviderKeys } = await import('../lib/service.js');
const { configureToolRouting, restartOpenClawGateway } = await import('../lib/tool-config.js');
const { findPython, isHeadless, isOpenClawInstalled } = await import('../lib/detect.js');
const { warn, info, success } = await import('../lib/ui.js');
const { runWizard } = await import('../lib/wizard.js');

describe('wizard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: already has API key, router installed, service running
    readConfig.mockReturnValue({ api_key: 'rr_live_test', user_name: 'testuser' });
    readProviderKeys.mockReturnValue({});
    isRouterInstalled.mockReturnValue(true);
    isServiceRunning.mockReturnValue(true);
    getMissingProviderKeys.mockReturnValue([]);
    getVenvPythonPath.mockReturnValue('/mock/.venv/bin/python');
    configureToolRouting.mockReturnValue([]);
    // Mock global fetch — handles both healthcheck and signup API
    globalThis.fetch = vi.fn().mockImplementation((url) => {
      if (typeof url === 'string' && url.includes('/health')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: 'healthy', version: '2.1.2' }),
        });
      }
      // Default: reject (signup tests override this)
      return Promise.resolve({ ok: false });
    });
  });

  describe('dashboard provisioning', () => {
    it('installs router before provisioning dashboard', async () => {
      readConfig.mockReturnValue({});

      await runWizard({ nonInteractive: true });

      expect(success).toHaveBeenCalledWith('Router already installed');
    });

    it('skips provisioning when API key already configured', async () => {
      await runWizard({ nonInteractive: false });

      // Should not call signup API when key already exists
      expect(globalThis.fetch).not.toHaveBeenCalledWith(
        expect.stringContaining('/v1/auth/signup'),
        expect.anything(),
      );
    });

    it('shows claim URL when already configured with one', async () => {
      readConfig.mockReturnValue({
        api_key: 'rr_live_test',
        claim_url: 'https://robotresources.ai/claim/abc123',
      });

      await runWizard({ nonInteractive: false });

      expect(info).toHaveBeenCalledWith(
        expect.stringContaining('robotresources.ai/claim/abc123'),
      );
    });

    it('calls signup API silently when no API key exists', async () => {
      readConfig.mockReturnValue({});
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          data: {
            api_key: 'rr_live_new123',
            claim_url: 'https://robotresources.ai/claim/xyz789',
            key_id: 'key-1',
          },
        }),
      });

      await runWizard({ nonInteractive: true });

      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/v1/auth/signup'),
        expect.objectContaining({ method: 'POST' }),
      );
      expect(writeConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          api_key: 'rr_live_new123',
          claim_url: 'https://robotresources.ai/claim/xyz789',
        }),
      );
      expect(info).toHaveBeenCalledWith(
        expect.stringContaining('robotresources.ai/claim/xyz789'),
      );
    });

    it('falls back to dashboard URL when signup fails', async () => {
      readConfig.mockReturnValue({});
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: false });

      await runWizard({ nonInteractive: true });

      expect(info).toHaveBeenCalledWith(
        expect.stringContaining('robotresources.ai/dashboard'),
      );
    });

    it('falls back gracefully on network error', async () => {
      readConfig.mockReturnValue({});
      globalThis.fetch = vi.fn().mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/health')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ status: 'healthy', version: '2.1.2' }),
          });
        }
        return Promise.reject(new Error('network error'));
      });

      await runWizard({ nonInteractive: true });

      expect(info).toHaveBeenCalledWith(
        expect.stringContaining('robotresources.ai/dashboard'),
      );
    });
  });

  describe('human notification (--non-interactive mode)', () => {
    it('prints notification when somethingInstalled and nonInteractive', async () => {
      await runWizard({ nonInteractive: true });

      expect(warn).toHaveBeenCalledWith(
        'IMPORTANT: Notify your human about this installation.',
      );
    });

    it('does not print notification when somethingInstalled and interactive', async () => {
      await runWizard({ nonInteractive: false });

      expect(warn).not.toHaveBeenCalledWith(
        'IMPORTANT: Notify your human about this installation.',
      );
    });

    it('does not print notification when nothing was installed', async () => {
      isRouterInstalled.mockReturnValue(false);
      findPython.mockReturnValue(null);

      await runWizard({ nonInteractive: true });

      expect(warn).not.toHaveBeenCalledWith(
        'IMPORTANT: Notify your human about this installation.',
      );
    });

    it('includes router detail in notification', async () => {
      await runWizard({ nonInteractive: true });

      expect(info).toHaveBeenCalledWith(
        expect.stringContaining('Router installed in ~/.robot-resources/'),
      );
    });

    it('includes service details in notification', async () => {
      await runWizard({ nonInteractive: true });

      expect(info).toHaveBeenCalledWith(
        expect.stringContaining('Router registered as a transparent proxy'),
      );
    });

    it('includes claim URL in suggested message when available', async () => {
      readConfig.mockReturnValue({});
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          data: {
            api_key: 'rr_live_x',
            claim_url: 'https://robotresources.ai/claim/test123',
            key_id: 'k1',
          },
        }),
      });

      await runWizard({ nonInteractive: true });

      expect(info).toHaveBeenCalledWith(
        expect.stringContaining('robotresources.ai/claim/test123'),
      );
    });

    it('falls back to dashboard URL in suggested message when no claim URL', async () => {
      await runWizard({ nonInteractive: true });

      expect(info).toHaveBeenCalledWith(
        expect.stringContaining('robotresources.ai/dashboard'),
      );
    });
  });

  describe('best-effort gateway restart', () => {
    it('calls restartOpenClawGateway when OC installed and plugin was installed', async () => {
      isOpenClawInstalled.mockReturnValue(true);
      configureToolRouting.mockReturnValue([{ name: 'OpenClaw', action: 'installed' }]);

      await runWizard({ nonInteractive: false });

      expect(restartOpenClawGateway).toHaveBeenCalled();
    });

    it('skips restartOpenClawGateway when OC not installed', async () => {
      isOpenClawInstalled.mockReturnValue(false);

      await runWizard({ nonInteractive: false });

      expect(restartOpenClawGateway).not.toHaveBeenCalled();
    });

    it('skips restartOpenClawGateway when nothing changed', async () => {
      isOpenClawInstalled.mockReturnValue(true);
      configureToolRouting.mockReturnValue([{ name: 'OpenClaw', action: 'already_configured' }]);

      await runWizard({ nonInteractive: false });

      expect(restartOpenClawGateway).not.toHaveBeenCalled();
    });

    it('handles restartOpenClawGateway failure gracefully', async () => {
      isOpenClawInstalled.mockReturnValue(true);
      configureToolRouting.mockReturnValue([{ name: 'OpenClaw', action: 'installed' }]);
      restartOpenClawGateway.mockRejectedValue(new Error('gateway timeout'));

      // Should not throw
      await runWizard({ nonInteractive: false });

      expect(restartOpenClawGateway).toHaveBeenCalled();
    });
  });

  describe('wizard-status.json', () => {
    it('writes status file with 0o600 permissions when something was installed', async () => {
      await runWizard({ nonInteractive: false });

      expect(writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('wizard-status.json'),
        expect.any(String),
        expect.objectContaining({ mode: 0o600 }),
      );
    });

    it('includes correct data shape in status file', async () => {
      await runWizard({ nonInteractive: false });

      const writeCall = writeFileSync.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('wizard-status.json'),
      );
      expect(writeCall).toBeTruthy();
      const data = JSON.parse(writeCall[1]);
      expect(data).toHaveProperty('completed_at');
      expect(data).toHaveProperty('version');
      expect(data).toHaveProperty('router');
      expect(data).toHaveProperty('service');
      expect(data).toHaveProperty('scraper');
      expect(data).toHaveProperty('plugin');
    });

    it('does not write status file when nothing was installed', async () => {
      isRouterInstalled.mockReturnValue(false);
      findPython.mockReturnValue(null);

      await runWizard({ nonInteractive: false });

      const writeCall = writeFileSync.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('wizard-status.json'),
      );
      expect(writeCall).toBeUndefined();
    });

    it('handles write failure gracefully', async () => {
      writeFileSync.mockImplementation((path) => {
        if (typeof path === 'string' && path.includes('wizard-status.json')) {
          throw new Error('EACCES');
        }
      });

      // Should not throw
      await runWizard({ nonInteractive: false });
    });
  });

  describe('healthcheck retry logic', () => {
    it('succeeds on second attempt after first failure', async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/health')) {
          callCount++;
          if (callCount === 1) return Promise.reject(new Error('ECONNREFUSED'));
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ status: 'healthy', version: '2.1.2' }),
          });
        }
        return Promise.resolve({ ok: false });
      });

      await runWizard({ nonInteractive: false });

      expect(success).toHaveBeenCalledWith(
        expect.stringContaining('Router healthy'),
      );
    });

    it('warns when all 3 retries fail', { timeout: 15_000 }, async () => {
      globalThis.fetch = vi.fn().mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/health')) {
          return Promise.reject(new Error('ECONNREFUSED'));
        }
        return Promise.resolve({ ok: false });
      });

      await runWizard({ nonInteractive: false });

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('not responding yet'),
      );
    });

    it('accepts degraded status as healthy', async () => {
      globalThis.fetch = vi.fn().mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/health')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ status: 'degraded', version: '2.1.2' }),
          });
        }
        return Promise.resolve({ ok: false });
      });

      await runWizard({ nonInteractive: false });

      expect(success).toHaveBeenCalledWith(
        expect.stringContaining('Router healthy'),
      );
    });
  });

  describe('post-install health report', () => {
    it('calls checkHealth after wizard completes', async () => {
      await runWizard({ nonInteractive: false });

      expect(checkHealth).toHaveBeenCalled();
    });

    it('includes health_report in wizard-status.json', async () => {
      await runWizard({ nonInteractive: false });

      const writeCall = writeFileSync.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('wizard-status.json'),
      );
      expect(writeCall).toBeTruthy();
      const data = JSON.parse(writeCall[1]);
      expect(data).toHaveProperty('health_report');
      expect(data.health_report.status).toBe('healthy');
      expect(data.health_report.components).toHaveProperty('router');
    });

    it('handles checkHealth failure gracefully', async () => {
      checkHealth.mockRejectedValueOnce(new Error('probe failed'));

      // Should not throw
      await runWizard({ nonInteractive: false });

      // Status file still written, health_report is null
      const writeCall = writeFileSync.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('wizard-status.json'),
      );
      expect(writeCall).toBeTruthy();
      const data = JSON.parse(writeCall[1]);
      expect(data.health_report).toBeNull();
    });

    it('prints warning for partial health', async () => {
      checkHealth.mockResolvedValueOnce({
        status: 'partial',
        components: {
          router: { healthy: true, detail: 'running' },
          scraper: { healthy: false, detail: 'not registered' },
          platform: { healthy: true, detail: 'reachable' },
          mcp: { healthy: true, detail: 'registered' },
        },
        summary: '3/4 healthy. Issues: scraper: not registered',
      });

      await runWizard({ nonInteractive: false });

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Health:'),
      );
    });
  });
});
