import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The payload files/dirs that make up the plugin. Anything in installDir
// that isn't one of these (or a .bak-* / .failed-* / .new / .update.lock)
// is left alone.
const PAYLOAD_ENTRIES = ['index.js', 'openclaw.plugin.json', 'package.json', 'lib'];

function installDir() {
  // lib/safe-load.js lives inside installDir/lib/ — resolve up one level.
  return join(__dirname, '..');
}

function stateDir() {
  return join(homedir(), '.robot-resources');
}

function findBakDir(dir) {
  try {
    const names = readdirSync(dir);
    const baks = names.filter((n) => n.startsWith('.bak-'));
    if (baks.length === 0) return null;
    // Pick the most recently modified .bak-* — typically there's only one
    // (we prune to last 1), but be defensive.
    let best = null;
    let bestMtime = 0;
    for (const name of baks) {
      const full = join(dir, name);
      try {
        const m = statSync(full).mtimeMs;
        if (m > bestMtime) {
          bestMtime = m;
          best = full;
        }
      } catch { /* ignore */ }
    }
    return best;
  } catch {
    return null;
  }
}

function currentVersion(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

function emitRollbackTelemetry(payload) {
  // INLINE telemetry — must not import ./telemetry.js because that module
  // might be inside the broken release we're rolling back from.
  try {
    const cfgPath = join(stateDir(), 'config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    if (!cfg.api_key) return;
    const url = (cfg.platform_url || 'https://api.robotresources.ai').replace(/\/+$/, '');

    fetch(`${url}/v1/telemetry`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.api_key}`,
      },
      body: JSON.stringify({
        product: 'plugin',
        event_type: 'plugin_rollback_triggered',
        payload: {
          node_version: process.version,
          platform: process.platform,
          ...payload,
        },
      }),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => {});
  } catch { /* swallow — telemetry must never amplify a rollback failure */ }
}

/**
 * Restore the previous plugin version from a .bak-* sibling and arm a 24h
 * update-skip window so we don't retry the update we just rolled back from.
 *
 * This is called when index.js's top-level try/catch traps an error loading
 * or registering plugin-core.js. It is best-effort — if anything here throws,
 * we log and let the original load error propagate (OpenClaw will disable
 * the plugin for this session, and the user re-runs the wizard).
 */
export async function handleLoadFailure(err) {
  const dir = installDir();
  const failedVersion = currentVersion(dir);
  const bak = findBakDir(dir);

  // Clear any pending-swap marker. If we're rolling back, a staged update is
  // also suspect — don't retry it on next session.
  try { rmSync(join(stateDir(), '.pending-swap.json'), { force: true }); } catch { /* ignore */ }

  emitRollbackTelemetry({
    from: failedVersion,
    error_message: err?.message || String(err),
    error_stack: err?.stack ? String(err.stack).slice(0, 2_000) : null,
    has_bak: !!bak,
  });

  if (!bak) {
    // Nothing to restore from — this is the very first load that failed,
    // or a previous rollback already consumed the .bak. Only arm skip.
    armSkipWindow();
    return;
  }

  try {
    const failedDir = join(dir, `.failed-${failedVersion}-${Date.now()}`);
    mkdirSync(failedDir, { recursive: true });

    // Move current payload entries into .failed-*
    for (const entry of PAYLOAD_ENTRIES) {
      const src = join(dir, entry);
      if (!existsSync(src)) continue;
      renameSync(src, join(failedDir, entry));
    }

    // Move .bak payload entries into place
    for (const entry of PAYLOAD_ENTRIES) {
      const src = join(bak, entry);
      if (!existsSync(src)) continue;
      renameSync(src, join(dir, entry));
    }
  } catch { /* partial rollback — arm skip anyway */ }

  armSkipWindow();
}

function armSkipWindow() {
  try {
    mkdirSync(stateDir(), { recursive: true });
    const until = new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString();
    writeFileSync(join(stateDir(), '.update-skip-until'), until, 'utf-8');
  } catch { /* swallow */ }
}
