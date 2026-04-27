import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { acquireLock, releaseLock, rmSyncWithRetry } from './update-lock.js';
import { copyDir, PAYLOAD_ENTRIES, prunePreviousBaks } from './fs-helpers.js';
import { stagePendingSwap } from './pending-swap.js';

const TARBALL_TIMEOUT_MS = 30_000;

async function downloadTarball(url, destPath) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TARBALL_TIMEOUT_MS) });
  if (!res.ok || !res.body) {
    throw new Error(`tarball download failed: HTTP ${res.status}`);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(destPath));
}

function sha1File(path) {
  const hash = createHash('sha1');
  hash.update(readFileSync(path));
  return hash.digest('hex');
}

function currentVersion(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Downloads a new plugin tarball from npm and swaps it into place.
 *
 * On macOS/Linux: rename over live files — Unix inode semantics allow this
 * while Node has the files loaded. Takes effect on next session.
 *
 * On Windows (deferSwap = true): stage the new payload into `.pending-<to>/`
 * and write a marker. The shim (index.js) swaps on next session start, before
 * Node opens any plugin files. NTFS share locks aren't held at that moment,
 * so the rename succeeds.
 *
 * Returns `{ ok, reason, from, to, deferred }`. On `ok === false`, the install
 * dir is untouched.
 */
export async function performSelfUpdate({
  tarballUrl,
  shasum,
  installDir,
  telemetry,
  deferSwap = process.platform === 'win32',
  stateDir,
}) {
  const fromVersion = currentVersion(installDir);
  const lockPath = join(installDir, '.update.lock');
  const newDir = join(installDir, '.new');
  const tarballPath = join(newDir, 'plugin.tgz');

  if (!acquireLock(lockPath)) {
    telemetry?.emit('plugin_update_skipped', { from: fromVersion, reason: 'lock_held' });
    return { ok: false, reason: 'lock_held', from: fromVersion };
  }

  telemetry?.emit('plugin_update_attempted', { from: fromVersion, tarball_url: tarballUrl });

  try {
    // Fresh .new — wipe anything from a previous aborted run.
    rmSync(newDir, { recursive: true, force: true });
    mkdirSync(newDir, { recursive: true });

    // Download
    try {
      await downloadTarball(tarballUrl, tarballPath);
    } catch (err) {
      telemetry?.emit('plugin_update_download_failed', { from: fromVersion, error: err?.message });
      return { ok: false, reason: 'download_failed', from: fromVersion };
    }

    // Shasum check
    const actualSha = sha1File(tarballPath);
    if (actualSha.toLowerCase() !== String(shasum || '').toLowerCase()) {
      telemetry?.emit('plugin_update_download_failed', {
        from: fromVersion,
        reason: 'shasum_mismatch',
        expected: shasum,
        actual: actualSha,
      });
      return { ok: false, reason: 'shasum_mismatch', from: fromVersion };
    }

    // Extract via system tar — Windows 10 1803+ ships tar.exe in System32.
    const extractRes = spawnSync('tar', ['-xzf', tarballPath, '-C', newDir], {
      stdio: 'ignore',
      timeout: 30_000,
    });
    if (extractRes.status !== 0) {
      telemetry?.emit('plugin_update_failed', {
        from: fromVersion,
        stage: 'extract',
        status: extractRes.status,
      });
      return { ok: false, reason: 'extract_failed', from: fromVersion };
    }

    // Validate extracted package
    const extractedPkgDir = join(newDir, 'package');
    const extractedPkgJson = join(extractedPkgDir, 'package.json');
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(extractedPkgJson, 'utf-8'));
    } catch {
      telemetry?.emit('plugin_update_failed', { from: fromVersion, stage: 'parse_package_json' });
      return { ok: false, reason: 'parse_failed', from: fromVersion };
    }
    if (pkg.name !== '@robot-resources/router') {
      telemetry?.emit('plugin_update_failed', {
        from: fromVersion,
        stage: 'validate',
        bad_name: pkg.name,
      });
      return { ok: false, reason: 'wrong_package', from: fromVersion };
    }
    const toVersion = pkg.version || 'unknown';

    // Windows: stage into .pending-<to>/ and let the shim swap on next load.
    // The pre-swap backup is created by the shim at swap time; creating it
    // here would pin the current version to disk even when the user never
    // restarts (leaves a confusing half-state).
    if (deferSwap) {
      try {
        stagePendingSwap({
          installDir,
          extractedPkgDir,
          fromVersion,
          toVersion,
          stateDir,
        });
      } catch (err) {
        telemetry?.emit('plugin_update_failed', {
          from: fromVersion,
          stage: 'stage_pending',
          error: err?.message,
        });
        return { ok: false, reason: 'stage_failed', from: fromVersion };
      }

      telemetry?.emit('plugin_update_staged', { from: fromVersion, to: toVersion });
      telemetry?.emit('plugin_update_pending_reload', { from: fromVersion, to: toVersion });
      return { ok: true, from: fromVersion, to: toVersion, deferred: true };
    }

    // Non-Windows: backup current payload into .bak-${fromVersion}/ (copy-then-
    // rename semantics via directory-level copy). Use copyFileSync + mkdirSync
    // rather than rename so the original stays available up to the final swap.
    const bakDir = join(installDir, `.bak-${fromVersion}`);
    try {
      rmSync(bakDir, { recursive: true, force: true });
      mkdirSync(bakDir, { recursive: true });
      for (const entry of PAYLOAD_ENTRIES) {
        const src = join(installDir, entry);
        if (!existsSync(src)) continue;
        copyDir(src, join(bakDir, entry));
      }
    } catch (err) {
      telemetry?.emit('plugin_update_failed', { from: fromVersion, stage: 'backup', error: err?.message });
      return { ok: false, reason: 'backup_failed', from: fromVersion };
    }

    // Swap: rename extracted entries over current. This is the final step.
    try {
      for (const entry of PAYLOAD_ENTRIES) {
        const src = join(extractedPkgDir, entry);
        const dst = join(installDir, entry);
        if (!existsSync(src)) continue;
        // Clear destination first, then move in place.
        rmSync(dst, { recursive: true, force: true });
        renameSync(src, dst);
      }
    } catch (err) {
      telemetry?.emit('plugin_update_failed', { from: fromVersion, stage: 'swap', error: err?.message });
      return { ok: false, reason: 'swap_failed', from: fromVersion };
    }

    // Prune older baks (keep last 1)
    prunePreviousBaks(installDir, 1);

    // Write diagnostics
    try {
      writeFileSync(
        join(installDir, '.last-update'),
        JSON.stringify({
          from: fromVersion,
          to: toVersion,
          at: new Date().toISOString(),
          tarball_url: tarballUrl,
        }, null, 2),
        'utf-8',
      );
    } catch { /* best-effort */ }

    telemetry?.emit('plugin_update_succeeded', { from: fromVersion, to: toVersion });
    telemetry?.emit('plugin_update_pending_reload', { from: fromVersion, to: toVersion });
    return { ok: true, from: fromVersion, to: toVersion };
  } finally {
    // Always clean .new staging + release lock. rmSyncWithRetry defends
    // against Windows AV holding EBUSY on freshly-extracted files.
    rmSyncWithRetry(newDir);
    releaseLock(lockPath);
  }
}
