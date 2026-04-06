import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { readProviderKeys } from '@robot-resources/cli-core/config.mjs';

const LABEL = 'ai.robotresources.router';
const SERVICE_NAME = 'robot-resources-router.service';
const ROUTER_PORT = 3838;

// Maps config.json provider_keys names to environment variable names
const CONFIG_TO_ENV = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GOOGLE_API_KEY',
};

// ─── Environment detection ──────────────────────────────────────────────────

function isDocker() {
  return existsSync('/.dockerenv') ||
    (existsSync('/proc/1/cgroup') &&
      readFileSync('/proc/1/cgroup', 'utf-8').includes('docker'));
}

function isWSL() {
  try {
    const version = readFileSync('/proc/version', 'utf-8');
    return /microsoft|wsl/i.test(version);
  } catch {
    return false;
  }
}

function hasSystemd() {
  // systemd is PID 1 — check if /run/systemd/system exists (standard detection)
  return existsSync('/run/systemd/system');
}

function isRoot() {
  return process.getuid?.() === 0;
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

function resolveProviderEnv() {
  const configKeys = readProviderKeys();
  const keyNames = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY'];
  const resolvedKeys = {};
  for (const key of keyNames) {
    if (process.env[key]) {
      resolvedKeys[key] = process.env[key];
    }
  }
  for (const [configName, envName] of Object.entries(CONFIG_TO_ENV)) {
    if (!resolvedKeys[envName] && configKeys[configName]) {
      resolvedKeys[envName] = configKeys[configName];
    }
  }
  resolvedKeys['PATH'] = '/usr/local/bin:/usr/bin:/bin';
  return resolvedKeys;
}

function writeEnvFile(resolvedKeys) {
  const envDir = join(homedir(), '.robot-resources');
  const envPath = join(envDir, 'router.env');
  mkdirSync(envDir, { recursive: true });
  const lines = Object.entries(resolvedKeys)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  writeFileSync(envPath, lines + '\n', { mode: 0o600 });
  return envPath;
}

// ─── macOS (launchd) ────────────────────────────────────────────────────────

function getPlistPath() {
  return join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

function buildPlist(venvPythonPath) {
  const home = homedir();
  const logsDir = join(home, '.robot-resources', 'logs');

  // Snapshot provider API keys: env vars take priority, then config.json
  const envVars = {};
  const configKeys = readProviderKeys();
  const keyNames = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY'];
  for (const key of keyNames) {
    const value = process.env[key];
    if (value) {
      envVars[key] = value;
    }
  }
  // Fill in from config.json for any keys not found in environment
  for (const [configName, envName] of Object.entries(CONFIG_TO_ENV)) {
    if (!envVars[envName] && configKeys[configName]) {
      envVars[envName] = configKeys[configName];
    }
  }
  // Ensure PATH includes common binary locations
  envVars.PATH = '/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin';

  const envEntries = Object.entries(envVars)
    .map(([k, v]) => `      <key>${k}</key>\n      <string>${v}</string>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${venvPythonPath}</string>
    <string>-m</string>
    <string>robot_resources.cli.main</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logsDir}/router.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${logsDir}/router.stderr.log</string>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>
  <key>WorkingDirectory</key>
  <string>${home}/.robot-resources</string>
</dict>
</plist>
`;
}

function installLaunchd(venvPythonPath) {
  const plistPath = getPlistPath();
  const logsDir = join(homedir(), '.robot-resources', 'logs');
  const launchAgentsDir = join(homedir(), 'Library', 'LaunchAgents');

  mkdirSync(logsDir, { recursive: true });
  mkdirSync(launchAgentsDir, { recursive: true });

  // Unload existing service if present
  if (existsSync(plistPath)) {
    try {
      execSync(`launchctl bootout gui/$(id -u) "${plistPath}" 2>/dev/null`, { stdio: 'pipe' });
    } catch {
      // Not loaded — fine
    }
  }

  writeFileSync(plistPath, buildPlist(venvPythonPath));
  chmodSync(plistPath, 0o600);
  execSync(`launchctl bootstrap gui/$(id -u) "${plistPath}"`, { stdio: 'pipe' });
}

function uninstallLaunchd() {
  const plistPath = getPlistPath();
  if (!existsSync(plistPath)) return;

  try {
    execSync(`launchctl bootout gui/$(id -u) "${plistPath}" 2>/dev/null`, { stdio: 'pipe' });
  } catch {
    // Already unloaded
  }
  unlinkSync(plistPath);
}

function isLaunchdRunning() {
  try {
    const output = execSync(`launchctl print gui/$(id -u)/${LABEL} 2>&1`, { encoding: 'utf-8' });
    return output.includes('state = running');
  } catch {
    return false;
  }
}

// ─── Linux: systemd user service ────────────────────────────────────────────

function getUserUnitPath() {
  return join(homedir(), '.config', 'systemd', 'user', SERVICE_NAME);
}

function buildUserUnit(venvPythonPath, envFilePath) {
  const home = homedir();
  const logsDir = join(home, '.robot-resources', 'logs');

  return `[Unit]
Description=Robot Resources Router — LLM cost optimization proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${venvPythonPath} -m robot_resources.cli.main start
Restart=on-failure
RestartSec=5
EnvironmentFile=${envFilePath}
WorkingDirectory=${home}/.robot-resources
StandardOutput=append:${logsDir}/router.stdout.log
StandardError=append:${logsDir}/router.stderr.log

[Install]
WantedBy=default.target
`;
}

function installSystemdUser(venvPythonPath) {
  const unitPath = getUserUnitPath();
  const logsDir = join(homedir(), '.robot-resources', 'logs');
  const unitDir = dirname(unitPath);

  mkdirSync(logsDir, { recursive: true });
  mkdirSync(unitDir, { recursive: true });

  const resolvedKeys = resolveProviderEnv();
  const envFilePath = writeEnvFile(resolvedKeys);
  writeFileSync(unitPath, buildUserUnit(venvPythonPath, envFilePath));
  chmodSync(unitPath, 0o600);
  execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
  execSync('systemctl --user enable robot-resources-router.service', { stdio: 'pipe' });
  execSync('systemctl --user start robot-resources-router.service', { stdio: 'pipe' });

  // Enable linger so the service survives SSH disconnects (critical for VMs)
  try {
    execSync('loginctl enable-linger', { stdio: 'pipe' });
  } catch {
    // Non-fatal — linger may not be available (e.g. no loginctl)
  }
}

function uninstallSystemdUser() {
  const unitPath = getUserUnitPath();
  if (!existsSync(unitPath)) return;

  try {
    execSync('systemctl --user stop robot-resources-router.service', { stdio: 'pipe' });
    execSync('systemctl --user disable robot-resources-router.service', { stdio: 'pipe' });
  } catch {
    // Already stopped
  }
  unlinkSync(unitPath);
  execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
}

// ─── Linux: systemd system service (root / VMs / servers) ───────────────────

const SYSTEM_UNIT_PATH = `/etc/systemd/system/${SERVICE_NAME}`;

function buildSystemUnit(venvPythonPath, envFilePath) {
  const home = homedir();
  const logsDir = join(home, '.robot-resources', 'logs');

  return `[Unit]
Description=Robot Resources Router — LLM cost optimization proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
ExecStart=${venvPythonPath} -m robot_resources.cli.main start
Restart=on-failure
RestartSec=5
EnvironmentFile=${envFilePath}
WorkingDirectory=${home}/.robot-resources
StandardOutput=append:${logsDir}/router.stdout.log
StandardError=append:${logsDir}/router.stderr.log

[Install]
WantedBy=multi-user.target
`;
}

function installSystemdSystem(venvPythonPath) {
  const logsDir = join(homedir(), '.robot-resources', 'logs');
  mkdirSync(logsDir, { recursive: true });

  const resolvedKeys = resolveProviderEnv();
  const envFilePath = writeEnvFile(resolvedKeys);
  writeFileSync(SYSTEM_UNIT_PATH, buildSystemUnit(venvPythonPath, envFilePath));
  chmodSync(SYSTEM_UNIT_PATH, 0o644);
  execSync('systemctl daemon-reload', { stdio: 'pipe' });
  execSync(`systemctl enable ${SERVICE_NAME}`, { stdio: 'pipe' });
  execSync(`systemctl start ${SERVICE_NAME}`, { stdio: 'pipe' });
}

function uninstallSystemdSystem() {
  if (!existsSync(SYSTEM_UNIT_PATH)) return;

  try {
    execSync(`systemctl stop ${SERVICE_NAME}`, { stdio: 'pipe' });
    execSync(`systemctl disable ${SERVICE_NAME}`, { stdio: 'pipe' });
  } catch {
    // Already stopped
  }
  unlinkSync(SYSTEM_UNIT_PATH);
  execSync('systemctl daemon-reload', { stdio: 'pipe' });
}

// ─── Linux routing logic ────────────────────────────────────────────────────

function getLinuxMode() {
  if (isDocker()) return 'docker';
  if (isWSL() && !hasSystemd()) return 'wsl-no-systemd';
  if (isRoot()) return 'system';
  return 'user';
}

function getLinuxUnitPath() {
  return isRoot() ? SYSTEM_UNIT_PATH : getUserUnitPath();
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Register the router as a system service and start it.
 */
export function installService(venvPythonPath) {
  if (process.platform === 'darwin') {
    installLaunchd(venvPythonPath);
    return { type: 'launchd', path: getPlistPath() };
  }

  if (process.platform === 'linux') {
    const mode = getLinuxMode();

    if (mode === 'docker') {
      return {
        type: 'skipped',
        reason: 'Running inside Docker — service registration skipped.\n' +
          '  Add this to your Dockerfile or entrypoint instead:\n' +
          `  ${venvPythonPath} -m robot_resources.cli.main start`,
      };
    }

    if (mode === 'wsl-no-systemd') {
      return {
        type: 'skipped',
        reason: 'WSL without systemd detected — service registration skipped.\n' +
          '  Enable systemd in WSL (wsl.conf → [boot] systemd=true) or run manually:\n' +
          `  ${venvPythonPath} -m robot_resources.cli.main start`,
      };
    }

    if (mode === 'system') {
      installSystemdSystem(venvPythonPath);
      return { type: 'systemd-system', path: SYSTEM_UNIT_PATH };
    }

    // mode === 'user'
    installSystemdUser(venvPythonPath);
    return { type: 'systemd-user', path: getUserUnitPath() };
  }

  throw new Error(
    `Service registration not supported on ${process.platform}.\n` +
    `  Run the router manually: rr-router start`
  );
}

/**
 * Stop and remove the router service.
 */
export function uninstallService() {
  if (process.platform === 'darwin') return uninstallLaunchd();
  if (process.platform === 'linux') {
    // Clean up whichever variant is installed
    if (existsSync(SYSTEM_UNIT_PATH)) return uninstallSystemdSystem();
    if (existsSync(getUserUnitPath())) return uninstallSystemdUser();
  }
}

/**
 * Check if the router service is currently running.
 */
export function isServiceRunning() {
  if (process.platform === 'darwin') return isLaunchdRunning();
  if (process.platform === 'linux') {
    // Check system-level first, then user-level
    if (existsSync(SYSTEM_UNIT_PATH)) {
      try {
        execSync(`systemctl is-active ${SERVICE_NAME}`, { stdio: 'pipe' });
        return true;
      } catch {
        return false;
      }
    }
    try {
      execSync(`systemctl --user is-active ${SERVICE_NAME}`, { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Check if a service config file exists.
 */
export function isServiceInstalled() {
  if (process.platform === 'darwin') return existsSync(getPlistPath());
  if (process.platform === 'linux') return existsSync(SYSTEM_UNIT_PATH) || existsSync(getUserUnitPath());
  return false;
}

/**
 * Get missing provider API keys (not in environment or config.json).
 */
export function getMissingProviderKeys() {
  const keys = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY'];
  const configKeys = readProviderKeys();
  return keys.filter((k) => {
    if (process.env[k]) return false;
    // Check config.json using the provider name mapping
    const configName = Object.entries(CONFIG_TO_ENV).find(([, env]) => env === k)?.[0];
    return !configName || !configKeys[configName];
  });
}
