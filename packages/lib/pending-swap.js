/**
 * Windows deferred-swap mechanism.
 *
 * On Windows, performSelfUpdate can't rename over live plugin files mid-session
 * because NTFS holds share-mode locks on them. Instead:
 *
 *   stagePendingSwap()  → called from performSelfUpdate when deferSwap=true.
 *                          Copies the extracted payload into
 *                          {installDir}/.pending-<to>/ and writes a marker at
 *                          {stateDir}/.pending-swap.json.
 *
 *   applyPendingSwap()  → called SYNCHRONOUSLY from index.js at the top of
 *                          each plugin load, BEFORE plugin-core.js is imported.
 *                          At this moment, Node has not yet opened the payload
 *                          files, so the rename from .pending-<to>/ over live
 *                          files succeeds. The pre-swap state is preserved in
 *                          .bak-<from>/ for rollback.
 *
 * Both functions are side-effect-free when there is nothing to do. Both are
 * fully synchronous (no top-level await — that's exactly the bug PR #137
 * fixed). applyPendingSwap() in particular never throws: any failure
 * quarantines the pending dir, arms a 24h skip window, and falls through so
 * the shim can continue loading the current (unchanged) version.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { acquireLock, releaseLock, rmSyncWithRetry } from './update-lock.js';
import { copyDir, PAYLOAD_ENTRIES, prunePreviousBaks } from './fs-helpers.js';

const MARKER_FILENAME = '.pending-swap.json';
const SKIP_UNTIL_FILENAME = '.update-skip-until';
const LAST_UPDATE_FILENAME = '.last-update';
const SKIP_WINDOW_MS = 24 * 60 * 60 * 1_000;

function defaultStateDir() {
  return join(homedir(), '.robot-resources');
}

export function markerPath(stateDir = defaultStateDir()) {
  return join(stateDir, MARKER_FILENAME);
}

export function readPendingMarker(stateDir = defaultStateDir()) {
  try {
    return JSON.parse(readFileSync(markerPath(stateDir), 'utf-8'));
  } catch {
    return null;
  }
}

export function stagePendingSwap({ installDir, extractedPkgDir, fromVersion, toVersion, stateDir = defaultStateDir() }) {
  const pendingDirName = `.pending-${toVersion}`;
  const pendingDir = join(installDir, pendingDirName);

  rmSync(pendingDir, { recursive: true, force: true });
  mkdirSync(pendingDir, { recursive: true });

  for (const entry of PAYLOAD_ENTRIES) {
    const src = join(extractedPkgDir, entry);
    if (!existsSync(src)) continue;
    copyDir(src, join(pendingDir, entry));
  }

  const marker = {
    from: fromVersion,
    to: toVersion,
    staged_at: new Date().toISOString(),
    install_dir: installDir,
    payload_dir: pendingDirName,
  };

  mkdirSync(stateDir, { recursive: true });
  writeFileSync(markerPath(stateDir), JSON.stringify(marker, null, 2), 'utf-8');

  return { pendingDir, markerPath: markerPath(stateDir) };
}

function emitSwapTelemetry(stateDir, eventType, payload) {
  // Inline telemetry — mirrors safe-load.js emitRollbackTelemetry. Do not
  // import lib/telemetry.js: at swap time, lib/ may itself be mid-rename.
  try {
    const cfg = JSON.parse(readFileSync(join(stateDir, 'config.json'), 'utf-8'));
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
        event_type: eventType,
        payload: {
          node_version: process.version,
          platform: process.platform,
          ...payload,
        },
      }),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => {});
  } catch { /* swallow — telemetry must never break the swap */ }
}

function armSkipWindow(stateDir) {
  try {
    mkdirSync(stateDir, { recursive: true });
    const until = new Date(Date.now() + SKIP_WINDOW_MS).toISOString();
    writeFileSync(join(stateDir, SKIP_UNTIL_FILENAME), until, 'utf-8');
  } catch { /* swallow */ }
}

/**
 * Quarantine a failed swap: move `.pending-<to>/` into `.failed-pending-<to>-<ts>/`,
 * clear the marker, arm the 24h skip window, and emit swap_failed telemetry.
 *
 * Exported so tests can verify the recovery plumbing without having to force
 * a real filesystem failure, and so production callers can re-enter this path
 * deterministically if they detect a problem out-of-band.
 */
export function quarantinePending({ marker, installDir, stateDir = defaultStateDir(), error }) {
  const pendingDir = join(installDir, marker.payload_dir || `.pending-${marker.to}`);
  const failedPath = join(installDir, `.failed-pending-${marker.to}-${Date.now()}`);

  try {
    renameSync(pendingDir, failedPath);
  } catch { /* pending may already be gone or partially cleaned */ }

  try { rmSync(markerPath(stateDir), { force: true }); } catch { /* ignore */ }

  armSkipWindow(stateDir);

  emitSwapTelemetry(stateDir, 'plugin_update_swap_failed', {
    from: marker.from,
    to: marker.to,
    error_message: error?.message || String(error || 'unspecified'),
  });

  return { quarantined_at: failedPath };
}

/**
 * Apply a staged Windows update. Safe to call at every plugin load — no-ops
 * if there's no marker. Never throws: swap failures quarantine the pending
 * dir, arm a 24h skip window, and fall through.
 *
 * `installDir` defaults to the directory containing this module's package
 * (resolved by the caller). `stateDir` defaults to `~/.robot-resources/`.
 *
 * Returns an object describing what happened: `{ action, from, to, reason }`
 * where action is one of 'none' | 'swapped' | 'skipped' | 'failed' |
 * 'stale-cleared'. Intended for tests and diagnostics.
 */
export function applyPendingSwap({ installDir, stateDir = defaultStateDir() } = {}) {
  let marker;
  try {
    marker = readPendingMarker(stateDir);
  } catch {
    return { action: 'none', reason: 'marker_read_failed' };
  }
  if (!marker) return { action: 'none' };

  const dir = installDir || marker.install_dir;
  if (!dir) return { action: 'none', reason: 'no_install_dir' };

  const pendingDir = join(dir, marker.payload_dir || `.pending-${marker.to}`);
  const lockPath = join(dir, '.update.lock');

  if (!existsSync(pendingDir)) {
    try { rmSync(markerPath(stateDir), { force: true }); } catch { /* ignore */ }
    return { action: 'stale-cleared', from: marker.from, to: marker.to };
  }

  if (!acquireLock(lockPath)) {
    return { action: 'skipped', reason: 'lock_held', from: marker.from, to: marker.to };
  }

  try {
    // Pre-swap backup. Created here (not at staging time) so the pre-swap
    // state is always recoverable — a staged update that's never applied
    // shouldn't leave a stale backup behind.
    const bakDir = join(dir, `.bak-${marker.from}`);
    rmSync(bakDir, { recursive: true, force: true });
    mkdirSync(bakDir, { recursive: true });
    for (const entry of PAYLOAD_ENTRIES) {
      const src = join(dir, entry);
      if (!existsSync(src)) continue;
      copyDir(src, join(bakDir, entry));
    }

    // Swap each payload entry.
    for (const entry of PAYLOAD_ENTRIES) {
      const src = join(pendingDir, entry);
      const dst = join(dir, entry);
      if (!existsSync(src)) continue;
      rmSync(dst, { recursive: true, force: true });
      renameSync(src, dst);
    }

    try { rmSync(markerPath(stateDir), { force: true }); } catch { /* ignore */ }
    rmSyncWithRetry(pendingDir);
    prunePreviousBaks(dir, 1);

    try {
      writeFileSync(
        join(dir, LAST_UPDATE_FILENAME),
        JSON.stringify({
          from: marker.from,
          to: marker.to,
          at: new Date().toISOString(),
          staged_at: marker.staged_at,
          deferred: true,
        }, null, 2),
        'utf-8',
      );
    } catch { /* best-effort */ }

    emitSwapTelemetry(stateDir, 'plugin_update_swapped', {
      from: marker.from,
      to: marker.to,
      staged_at: marker.staged_at,
    });

    return { action: 'swapped', from: marker.from, to: marker.to };
  } catch (err) {
    quarantinePending({ marker, installDir: dir, stateDir, error: err });
    return { action: 'failed', from: marker.from, to: marker.to, reason: err?.message };
  } finally {
    releaseLock(lockPath);
  }
}
