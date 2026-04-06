import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  mkdirSync: vi.fn(),
  chmodSync: vi.fn(),
}));

vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/mock-home'),
}));

vi.mock('@robot-resources/cli-core/config.mjs', () => ({
  readProviderKeys: vi.fn(() => ({})),
}));

const { execSync } = await import('node:child_process');
const { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } = await import('node:fs');
const { homedir } = await import('node:os');
const { readProviderKeys } = await import('@robot-resources/cli-core/config.mjs');
const { installService, uninstallService, isServiceRunning, isServiceInstalled, getMissingProviderKeys } =
  await import('../lib/service.js');

// Helper to mock Linux non-root environment
function setupLinuxUser() {
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  // No /.dockerenv, no WSL in /proc/version, systemd present
  existsSync.mockImplementation((path) => {
    if (path === '/.dockerenv') return false;
    if (path === '/proc/1/cgroup') return false;
    if (path === '/run/systemd/system') return true;
    return false;
  });
  readFileSync.mockReturnValue('');
  process.getuid = () => 1000;
}

// Helper to mock Linux root environment
function setupLinuxRoot() {
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  existsSync.mockImplementation((path) => {
    if (path === '/.dockerenv') return false;
    if (path === '/proc/1/cgroup') return false;
    if (path === '/run/systemd/system') return true;
    return false;
  });
  readFileSync.mockReturnValue('');
  process.getuid = () => 0;
}

describe('service', () => {
  let originalPlatform;
  let originalEnv;
  let originalGetuid;

  beforeEach(() => {
    vi.resetAllMocks();
    // Restore mock defaults after resetAllMocks clears return values
    homedir.mockReturnValue('/mock-home');
    readProviderKeys.mockReturnValue({});
    originalPlatform = process.platform;
    originalEnv = { ...process.env };
    originalGetuid = process.getuid;
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    process.env = originalEnv;
    if (originalGetuid) {
      process.getuid = originalGetuid;
    }
  });

  describe('installService', () => {
    // ─── macOS (launchd) ──────────────────────────────────────────────────

    it('generates a launchd plist on macOS', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      existsSync.mockReturnValue(false);

      const result = installService('/mock-home/.robot-resources/.venv/bin/python3');

      expect(result.type).toBe('launchd');
      expect(result.path).toContain('ai.robotresources.router.plist');
    });

    it('plist contains the venv python path in ProgramArguments', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      existsSync.mockReturnValue(false);

      installService('/custom/venv/bin/python3');

      const plistContent = writeFileSync.mock.calls[0][1];
      expect(plistContent).toContain('/custom/venv/bin/python3');
    });

    it('plist includes robot_resources.cli.main start command', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      existsSync.mockReturnValue(false);

      installService('/venv/bin/python3');

      const plistContent = writeFileSync.mock.calls[0][1];
      expect(plistContent).toContain('robot_resources.cli.main');
      expect(plistContent).toContain('start');
    });

    it('plist sets RunAtLoad and KeepAlive to true', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      existsSync.mockReturnValue(false);

      installService('/venv/bin/python3');

      const plistContent = writeFileSync.mock.calls[0][1];
      expect(plistContent).toContain('<key>RunAtLoad</key>');
      expect(plistContent).toContain('<key>KeepAlive</key>');
    });

    it('plist includes environment variables when provider keys are set in env', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      existsSync.mockReturnValue(false);
      process.env.OPENAI_API_KEY = 'sk-test-key';

      installService('/venv/bin/python3');

      const plistContent = writeFileSync.mock.calls[0][1];
      expect(plistContent).toContain('<key>OPENAI_API_KEY</key>');
      expect(plistContent).toContain('<string>sk-test-key</string>');

      delete process.env.OPENAI_API_KEY;
    });

    it('plist pulls provider keys from config.json when env is empty', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      existsSync.mockReturnValue(false);
      readProviderKeys.mockReturnValue({ openai: 'sk-from-config' });

      installService('/venv/bin/python3');

      const plistContent = writeFileSync.mock.calls[0][1];
      expect(plistContent).toContain('<key>OPENAI_API_KEY</key>');
      expect(plistContent).toContain('<string>sk-from-config</string>');
    });

    it('env vars take priority over config.json keys in plist', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      existsSync.mockReturnValue(false);
      process.env.OPENAI_API_KEY = 'sk-from-env';
      readProviderKeys.mockReturnValue({ openai: 'sk-from-config' });

      installService('/venv/bin/python3');

      const plistContent = writeFileSync.mock.calls[0][1];
      expect(plistContent).toContain('<string>sk-from-env</string>');
      expect(plistContent).not.toContain('sk-from-config');

      delete process.env.OPENAI_API_KEY;
    });

    it('creates logs directory before writing service file', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      existsSync.mockReturnValue(false);

      installService('/venv/bin/python3');

      expect(mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('logs'),
        { recursive: true },
      );
    });

    it('unloads existing service before writing new plist on macOS', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      existsSync.mockReturnValue(true);

      installService('/venv/bin/python3');

      // First execSync call should be the bootout (unload)
      const firstCall = execSync.mock.calls[0][0];
      expect(firstCall).toContain('bootout');
    });

    it('sets plist file permissions to 0o600 after writing', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      existsSync.mockReturnValue(false);

      installService('/venv/bin/python3');

      expect(chmodSync).toHaveBeenCalledWith(
        expect.stringContaining('ai.robotresources.router.plist'),
        0o600,
      );
    });

    it('plist includes PATH environment variable', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      existsSync.mockReturnValue(false);

      installService('/venv/bin/python3');

      const plistContent = writeFileSync.mock.calls[0][1];
      expect(plistContent).toContain('<key>PATH</key>');
      expect(plistContent).toContain('/usr/local/bin');
    });

    // ─── Linux: user service (non-root) ─────────────────────────────────

    it('generates a systemd user unit on Linux as non-root', () => {
      setupLinuxUser();

      const result = installService('/venv/bin/python3');

      expect(result.type).toBe('systemd-user');
      expect(result.path).toContain('robot-resources-router.service');
      expect(result.path).toContain('.config/systemd/user');
    });

    it('systemd user unit contains ExecStart with venv python path', () => {
      setupLinuxUser();

      installService('/custom/venv/bin/python3');

      const unitContent = writeFileSync.mock.calls.find(c => String(c[0]).endsWith('.service'))?.[1] ?? writeFileSync.mock.calls[0][1];
      expect(unitContent).toContain('ExecStart=/custom/venv/bin/python3 -m robot_resources.cli.main start');
    });

    it('systemd user unit has Restart=on-failure', () => {
      setupLinuxUser();

      installService('/venv/bin/python3');

      const unitContent = writeFileSync.mock.calls.find(c => String(c[0]).endsWith('.service'))?.[1] ?? writeFileSync.mock.calls[0][1];
      expect(unitContent).toContain('Restart=on-failure');
      expect(unitContent).toContain('RestartSec=5');
    });

    it('systemd user unit uses EnvironmentFile instead of inline secrets', () => {
      setupLinuxUser();
      process.env.ANTHROPIC_API_KEY = 'ant-test';

      installService('/venv/bin/python3');

      // env file written with restricted perms (first writeFileSync call)
      const envFileCall = writeFileSync.mock.calls.find(c => String(c[0]).endsWith('router.env'));
      expect(envFileCall).toBeTruthy();
      expect(envFileCall[1]).toContain('ANTHROPIC_API_KEY=ant-test');
      expect(envFileCall[2]).toEqual({ mode: 0o600 });

      // unit file references EnvironmentFile, NOT inline Environment=
      const unitCall = writeFileSync.mock.calls.find(c => String(c[0]).endsWith('.service'));
      expect(unitCall[1]).toContain('EnvironmentFile=');
      expect(unitCall[1]).not.toContain('Environment=ANTHROPIC_API_KEY');

      delete process.env.ANTHROPIC_API_KEY;
    });

    it('systemd user unit targets default.target', () => {
      setupLinuxUser();

      installService('/venv/bin/python3');

      const unitContent = writeFileSync.mock.calls.find(c => String(c[0]).endsWith('.service'))?.[1] ?? writeFileSync.mock.calls[0][1];
      expect(unitContent).toContain('WantedBy=default.target');
    });

    it('enables linger for user-level service', () => {
      setupLinuxUser();

      installService('/venv/bin/python3');

      const lingerCall = execSync.mock.calls.find(([cmd]) => cmd.includes('enable-linger'));
      expect(lingerCall).toBeDefined();
    });

    it('sets user systemd unit file permissions to 0o600', () => {
      setupLinuxUser();

      installService('/venv/bin/python3');

      expect(chmodSync).toHaveBeenCalledWith(
        expect.stringContaining('robot-resources-router.service'),
        0o600,
      );
    });

    // ─── Linux: system service (root / VMs) ─────────────────────────────

    it('generates a system-level systemd unit on Linux as root', () => {
      setupLinuxRoot();

      const result = installService('/venv/bin/python3');

      expect(result.type).toBe('systemd-system');
      expect(result.path).toBe('/etc/systemd/system/robot-resources-router.service');
    });

    it('system unit targets multi-user.target for boot persistence', () => {
      setupLinuxRoot();

      installService('/venv/bin/python3');

      const unitContent = writeFileSync.mock.calls.find(c => String(c[0]).endsWith('.service'))?.[1] ?? writeFileSync.mock.calls[0][1];
      expect(unitContent).toContain('WantedBy=multi-user.target');
    });

    it('system unit includes User=root directive', () => {
      setupLinuxRoot();

      installService('/venv/bin/python3');

      const unitContent = writeFileSync.mock.calls.find(c => String(c[0]).endsWith('.service'))?.[1] ?? writeFileSync.mock.calls[0][1];
      expect(unitContent).toContain('User=root');
    });

    it('system unit uses systemctl without --user flag', () => {
      setupLinuxRoot();

      installService('/venv/bin/python3');

      const systemctlCalls = execSync.mock.calls
        .map(([cmd]) => cmd)
        .filter((cmd) => cmd.includes('systemctl'));
      expect(systemctlCalls.length).toBeGreaterThan(0);
      systemctlCalls.forEach((cmd) => {
        expect(cmd).not.toContain('--user');
      });
    });

    it('sets system unit file permissions to 0o644', () => {
      setupLinuxRoot();

      installService('/venv/bin/python3');

      expect(chmodSync).toHaveBeenCalledWith(
        '/etc/systemd/system/robot-resources-router.service',
        0o644,
      );
    });

    // ─── Docker ─────────────────────────────────────────────────────────

    it('skips service registration inside Docker (/.dockerenv)', () => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      existsSync.mockImplementation((path) => path === '/.dockerenv');
      readFileSync.mockReturnValue('');
      process.getuid = () => 0;

      const result = installService('/venv/bin/python3');

      expect(result.type).toBe('skipped');
      expect(result.reason).toContain('Docker');
    });

    it('skips service registration inside Docker (cgroup detection)', () => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      existsSync.mockImplementation((path) => path === '/proc/1/cgroup');
      readFileSync.mockImplementation((path) => {
        if (path === '/proc/1/cgroup') return '12:devices:/docker/abc123';
        return '';
      });
      process.getuid = () => 0;

      const result = installService('/venv/bin/python3');

      expect(result.type).toBe('skipped');
      expect(result.reason).toContain('Docker');
    });

    // ─── WSL ────────────────────────────────────────────────────────────

    it('skips service registration on WSL without systemd', () => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      existsSync.mockImplementation((path) => {
        if (path === '/.dockerenv') return false;
        if (path === '/proc/1/cgroup') return false;
        if (path === '/run/systemd/system') return false;  // no systemd
        return false;
      });
      readFileSync.mockImplementation((path) => {
        if (path === '/proc/version') return 'Linux version 5.15.0-microsoft-standard-WSL2';
        return '';
      });
      process.getuid = () => 1000;

      const result = installService('/venv/bin/python3');

      expect(result.type).toBe('skipped');
      expect(result.reason).toContain('WSL');
    });

    it('installs normally on WSL with systemd enabled', () => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      existsSync.mockImplementation((path) => {
        if (path === '/.dockerenv') return false;
        if (path === '/proc/1/cgroup') return false;
        if (path === '/run/systemd/system') return true;  // systemd present
        return false;
      });
      readFileSync.mockImplementation((path) => {
        if (path === '/proc/version') return 'Linux version 5.15.0-microsoft-standard-WSL2';
        return '';
      });
      process.getuid = () => 1000;

      const result = installService('/venv/bin/python3');

      expect(result.type).toBe('systemd-user');
    });

    // ─── Unsupported platforms ──────────────────────────────────────────

    it('throws on unsupported platforms', () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

      expect(() => installService('/venv/bin/python3')).toThrow('not supported');
    });
  });

  describe('isServiceRunning', () => {
    it('returns true on macOS when launchctl reports running state', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      execSync.mockReturnValue('state = running');

      expect(isServiceRunning()).toBe(true);
    });

    it('returns false on macOS when launchctl reports non-running state', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      execSync.mockReturnValue('state = waiting');

      expect(isServiceRunning()).toBe(false);
    });

    it('returns false on macOS when launchctl throws (service not loaded)', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      execSync.mockImplementation(() => { throw new Error('not found'); });

      expect(isServiceRunning()).toBe(false);
    });

    it('checks system-level service first on Linux when system unit exists', () => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      existsSync.mockImplementation((path) => path === '/etc/systemd/system/robot-resources-router.service');
      execSync.mockReturnValue('active');

      expect(isServiceRunning()).toBe(true);
      expect(execSync).toHaveBeenCalledWith(
        expect.stringMatching(/^systemctl is-active/),
        expect.anything(),
      );
    });

    it('falls back to user-level service on Linux when no system unit', () => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      existsSync.mockReturnValue(false);
      execSync.mockReturnValue('active');

      expect(isServiceRunning()).toBe(true);
      expect(execSync).toHaveBeenCalledWith(
        expect.stringMatching(/systemctl --user is-active/),
        expect.anything(),
      );
    });

    it('returns false on Linux when systemctl is-active throws', () => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      existsSync.mockReturnValue(false);
      execSync.mockImplementation(() => { throw new Error('inactive'); });

      expect(isServiceRunning()).toBe(false);
    });

    it('returns false on unsupported platforms', () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

      expect(isServiceRunning()).toBe(false);
    });
  });

  describe('isServiceInstalled', () => {
    it('checks plist path on macOS', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      existsSync.mockReturnValue(true);

      expect(isServiceInstalled()).toBe(true);
      expect(existsSync).toHaveBeenCalledWith(
        expect.stringContaining('ai.robotresources.router.plist'),
      );
    });

    it('detects system-level unit on Linux', () => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      existsSync.mockImplementation((path) => path === '/etc/systemd/system/robot-resources-router.service');

      expect(isServiceInstalled()).toBe(true);
    });

    it('detects user-level unit on Linux', () => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      existsSync.mockImplementation((path) => path.includes('.config/systemd/user'));

      expect(isServiceInstalled()).toBe(true);
    });

    it('returns false on unsupported platforms', () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

      expect(isServiceInstalled()).toBe(false);
    });
  });

  describe('getMissingProviderKeys', () => {
    it('returns all keys when none are configured', () => {
      readProviderKeys.mockReturnValue({});
      // Ensure env vars are not set
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.GOOGLE_API_KEY;

      const missing = getMissingProviderKeys();

      expect(missing).toContain('ANTHROPIC_API_KEY');
      expect(missing).toContain('OPENAI_API_KEY');
      expect(missing).toContain('GOOGLE_API_KEY');
      expect(missing).toHaveLength(3);
    });

    it('excludes keys found in environment variables', () => {
      readProviderKeys.mockReturnValue({});
      process.env.OPENAI_API_KEY = 'sk-test';

      const missing = getMissingProviderKeys();

      expect(missing).not.toContain('OPENAI_API_KEY');
      expect(missing).toContain('ANTHROPIC_API_KEY');
      expect(missing).toContain('GOOGLE_API_KEY');

      delete process.env.OPENAI_API_KEY;
    });

    it('excludes keys found in config.json', () => {
      readProviderKeys.mockReturnValue({ anthropic: 'ant-key', google: 'goog-key' });
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.GOOGLE_API_KEY;

      const missing = getMissingProviderKeys();

      expect(missing).toEqual(['OPENAI_API_KEY']);
    });

    it('returns empty array when all keys are configured', () => {
      readProviderKeys.mockReturnValue({ openai: 'sk', anthropic: 'ant', google: 'goog' });

      const missing = getMissingProviderKeys();

      expect(missing).toEqual([]);
    });
  });
});
