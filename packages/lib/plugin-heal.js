/**
 * Plugin-side self-heal — parallel to the router's own self_heal.py.
 *
 * Router self-heal only fires on router STARTUP. That fails in the common
 * case we just diagnosed (Apr 23, Finland signup): router crashes, systemd
 * gives up, process never starts again. Router can't heal itself if it's
 * dead.
 *
 * The plugin has a second, independent trigger — every OpenClaw gateway
 * start. OC users launch OC; plugin loads; `runPluginHeal` fires. That
 * gives us a second chance to put the router back in the world.
 *
 * What this does:
 *   1. Pings /health. Healthy → emit no-op heartbeat, return.
 *   2. Unhealthy → acquire `~/.robot-resources/.heal.lock` (PID-based).
 *   3. Best-effort `loginctl enable-linger` so the next restart survives logout.
 *   4. If a systemd-user unit exists: `systemctl --user restart`.
 *   5. Fallback: spawn the router as a detached child (shares code with
 *      `tryStartRouter` in plugin-core — we import that helper).
 *   6. Re-poll /health up to 10s. Report success or failure via telemetry.
 *
 * Coordination with router self-heal: separate throttle markers
 * (`.plugin-heal-check` vs `.self-heal-*`), shared heal lock
 * (`.heal.lock`) to prevent concurrent pip/plugin swaps. Throttled to
 * once per hour so nag isn't noisy.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, platform as osPlatform } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const HEAL_THROTTLE_MS = 60 * 60 * 1000; // 1h

function pluginStateDir() {
  const dir = join(homedir(), '.robot-resources');
  try { mkdirSync(dir, { recursive: true }); } catch { /* already exists */ }
  return dir;
}

function throttlePath() {
  return join(pluginStateDir(), '.plugin-heal-check');
}

function lockPath() {
  return join(pluginStateDir(), '.heal.lock');
}

function isThrottleFresh() {
  try {
    const ts = readFileSync(throttlePath(), 'utf-8').trim();
    return Date.now() - Date.parse(ts) < HEAL_THROTTLE_MS;
  } catch {
    return false;
  }
}

function writeThrottle() {
  try {
    writeFileSync(throttlePath(), new Date().toISOString() + '\n', { mode: 0o600 });
  } catch { /* non-fatal */ }
}

/**
 * PID-based lock. Returns true on success. Releases via releaseHealLock.
 * If the PID inside a stale lock file isn't alive, we steal the lock —
 * otherwise two healers never back off and stranded users never recover.
 */
function acquireHealLock() {
  const path = lockPath();
  try {
    if (existsSync(path)) {
      const holder = parseInt(readFileSync(path, 'utf-8').trim(), 10);
      if (holder && holder !== process.pid) {
        try {
          // Signal 0 = liveness check. Throws ESRCH if the process is gone.
          process.kill(holder, 0);
          return false;
        } catch {
          // Holder is dead — proceed to overwrite.
        }
      }
    }
    writeFileSync(path, String(process.pid), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function releaseHealLock() {
  try {
    const path = lockPath();
    if (existsSync(path)) {
      const holder = parseInt(readFileSync(path, 'utf-8').trim(), 10);
      if (holder === process.pid) unlinkSync(path);
    }
  } catch { /* non-fatal */ }
}

async function pingHealth(routerUrl, timeoutMs = 2_000) {
  try {
    const res = await fetch(`${routerUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Enable systemd-user linger best-effort. Silent on non-Linux / failures —
 * we verify via show-user and report the boolean.
 */
function enableLinger() {
  if (osPlatform() !== 'linux') return { attempted: false, enabled: false };
  try {
    spawnSync('loginctl', ['enable-linger'], { stdio: 'pipe' });
  } catch { /* try verification anyway */ }
  try {
    const user = process.env.USER || process.env.LOGNAME;
    if (!user) return { attempted: true, enabled: false };
    const res = spawnSync('loginctl', ['show-user', user, '--property=Linger'], {
      stdio: 'pipe', encoding: 'utf-8',
    });
    const enabled = res.status === 0 && /^Linger=yes\s*$/m.test(res.stdout || '');
    return { attempted: true, enabled };
  } catch {
    return { attempted: true, enabled: false };
  }
}

/**
 * Try to restart a systemd-user unit. Returns true if the systemctl call
 * exited 0 — doesn't guarantee the process is healthy yet (caller polls).
 */
function systemctlUserRestart() {
  if (osPlatform() !== 'linux') return false;
  try {
    const res = spawnSync('systemctl', ['--user', 'restart', 'robot-resources-router.service'], {
      stdio: 'pipe',
    });
    return res.status === 0;
  } catch {
    return false;
  }
}

/**
 * Entry point — callable fire-and-forget from register(). Never throws.
 */
export async function runPluginHeal({ routerUrl, telemetry, logger, tryStartRouter } = {}) {
  try {
    if (isThrottleFresh()) return;
    writeThrottle();

    const healthy = await pingHealth(routerUrl);
    if (healthy) {
      telemetry?.emit('plugin_heal_skipped', { reason: 'already_healthy' });
      return;
    }

    if (!acquireHealLock()) {
      telemetry?.emit('plugin_heal_skipped', { reason: 'lock_held' });
      return;
    }

    try {
      telemetry?.emit('plugin_heal_attempted', { router_url: routerUrl, platform: osPlatform() });

      const linger = enableLinger();

      let method = null;
      const unitPath = join(homedir(), '.config', 'systemd', 'user', 'robot-resources-router.service');
      if (existsSync(unitPath) && systemctlUserRestart()) {
        method = 'systemctl_user_restart';
      } else if (typeof tryStartRouter === 'function') {
        // Fallback: shared detached-spawn logic from plugin-core.
        const ok = await tryStartRouter(routerUrl, telemetry);
        method = ok ? 'detached_spawn' : null;
      }

      // Poll /health for up to 10s regardless of which method we used.
      let recovered = false;
      for (let i = 0; i < 10; i++) {
        if (await pingHealth(routerUrl, 1_500)) { recovered = true; break; }
        await new Promise((r) => setTimeout(r, 1_000));
      }

      if (recovered) {
        telemetry?.emit('plugin_heal_succeeded', {
          method,
          linger_attempted: linger.attempted,
          linger_enabled: linger.enabled,
        });
        logger?.info?.('[robot-resources] Plugin healed router — it is back up.');
      } else {
        telemetry?.emit('plugin_heal_failed', {
          method,
          linger_attempted: linger.attempted,
          linger_enabled: linger.enabled,
        });
        logger?.warn?.('[robot-resources] Router was down and plugin could not revive it. Run: npx robot-resources');
      }
    } finally {
      releaseHealLock();
    }
  } catch (err) {
    // Absolutely must not throw up the stack.
    try { telemetry?.emit('plugin_heal_error', { error: err?.message || String(err) }); } catch { /* noop */ }
  }
}
