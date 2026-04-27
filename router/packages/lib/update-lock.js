import { closeSync, openSync, rmSync, statSync } from 'node:fs';

export const LOCK_STALE_MS = 10 * 60 * 1_000; // 10 minutes

export function acquireLock(lockPath) {
  try {
    const fd = openSync(lockPath, 'wx');
    closeSync(fd);
    return true;
  } catch {
    try {
      const st = statSync(lockPath);
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        rmSync(lockPath, { force: true });
        const fd = openSync(lockPath, 'wx');
        closeSync(fd);
        return true;
      }
    } catch { /* ignore */ }
    return false;
  }
}

export function releaseLock(lockPath) {
  try { rmSync(lockPath, { force: true }); } catch { /* ignore */ }
}

/**
 * rmSync with retry — Windows Defender / AV scanners can briefly hold EBUSY
 * on freshly-extracted files. A few 100ms retries clears it; after that, we
 * accept the best-effort result and move on.
 */
export function rmSyncWithRetry(path, opts = {}) {
  const { attempts = 3, delayMs = 100, recursive = true, force = true } = opts;
  for (let i = 0; i < attempts; i++) {
    try {
      rmSync(path, { recursive, force });
      return true;
    } catch {
      if (i === attempts - 1) return false;
      const end = Date.now() + delayMs;
      while (Date.now() < end) { /* spin */ }
    }
  }
  return false;
}
