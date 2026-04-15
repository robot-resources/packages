import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { performSelfUpdate } from './self-update.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_PLATFORM_URL = 'https://api.robotresources.ai';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000; // 24h
const VERSION_FETCH_TIMEOUT_MS = 5_000;

function stateDir() {
  return join(homedir(), '.robot-resources');
}

function installDir() {
  // lib/update-check.js → installDir is one level up.
  return join(__dirname, '..');
}

function readTimestamp(path) {
  try {
    return readFileSync(path, 'utf-8').trim();
  } catch {
    return null;
  }
}

function writeTimestamp(path, iso) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, iso, 'utf-8');
  } catch { /* best-effort */ }
}

function parseVersion(v) {
  const parts = String(v || '').split('.').map((n) => parseInt(n, 10));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

function compareVersions(a, b) {
  const av = parseVersion(a);
  const bv = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (av[i] < bv[i]) return -1;
    if (av[i] > bv[i]) return 1;
  }
  return 0;
}

function currentPluginVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(installDir(), 'package.json'), 'utf-8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Runs a single update check. Wrapped in a top-level try/catch so that NO
 * failure inside this path — network hiccup, bad JSON, disk error, anything —
 * can prevent the plugin's `register()` from completing.
 *
 * This is THE defensive invariant: the update mechanism is also what ships
 * future fixes. If this code itself breaks, we lose the ability to ship
 * fixes. Every exit point logs-and-returns; nothing throws up.
 */
export async function runUpdateCheck({ logger, telemetry } = {}) {
  try {
    await runUpdateCheckInner({ logger, telemetry });
  } catch (err) {
    try {
      logger?.warn?.(`[robot-resources] update-check failed: ${err?.message || err}`);
    } catch { /* swallow */ }
  }
}

async function runUpdateCheckInner({ logger, telemetry }) {
  // 1. Windows not yet supported for self-update (rename-over-open-file semantics).
  if (process.platform === 'win32') {
    return;
  }

  const state = stateDir();
  const lastCheckPath = join(state, '.update-check');
  const skipUntilPath = join(state, '.update-skip-until');

  // 2. Rollback cooldown — a previous update failed to load and we're waiting.
  const skipUntil = readTimestamp(skipUntilPath);
  if (skipUntil) {
    const skipMs = Date.parse(skipUntil);
    if (Number.isFinite(skipMs) && Date.now() < skipMs) {
      return;
    }
  }

  // 3. Throttle — at most once per 24h.
  const lastCheck = readTimestamp(lastCheckPath);
  if (lastCheck) {
    const lastMs = Date.parse(lastCheck);
    if (Number.isFinite(lastMs) && Date.now() - lastMs < CHECK_INTERVAL_MS) {
      return;
    }
  }

  // 4. Hit the version endpoint. Platform URL comes from config.json or env override.
  const platformUrl = resolvePlatformUrl();
  const versionUrl = process.env.RR_VERSION_URL || `${platformUrl}/v1/version`;

  let body;
  try {
    const res = await fetch(versionUrl, { signal: AbortSignal.timeout(VERSION_FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      writeTimestamp(lastCheckPath, new Date().toISOString());
      return;
    }
    body = await res.json();
  } catch {
    // Network / JSON failure — record the attempt so we don't hammer.
    writeTimestamp(lastCheckPath, new Date().toISOString());
    return;
  }

  // Record check attempt even if we decide not to update.
  writeTimestamp(lastCheckPath, new Date().toISOString());

  const plugin = body?.data?.plugin;
  if (!plugin || !plugin.version || !plugin.tarball_url || !plugin.shasum) {
    return;
  }

  // 5. Kill switch — operator halt.
  if (plugin.kill_switch === true) {
    telemetry?.emit('plugin_update_kill_switch_active', { latest: plugin.version });
    return;
  }

  // 6. Compare versions.
  const current = currentPluginVersion();
  if (compareVersions(current, plugin.version) >= 0) {
    return; // already up-to-date or ahead
  }

  logger?.info?.(`[robot-resources] Plugin update available: ${current} → ${plugin.version}. Installing.`);

  await performSelfUpdate({
    tarballUrl: plugin.tarball_url,
    shasum: plugin.shasum,
    installDir: installDir(),
    telemetry,
  });
}

function resolvePlatformUrl() {
  try {
    const cfg = JSON.parse(readFileSync(join(stateDir(), 'config.json'), 'utf-8'));
    if (cfg.platform_url) return String(cfg.platform_url).replace(/\/+$/, '');
  } catch { /* fall through */ }
  return DEFAULT_PLATFORM_URL;
}

export { compareVersions, parseVersion }; // for tests
