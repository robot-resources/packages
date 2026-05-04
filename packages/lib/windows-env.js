import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Windows NODE_OPTIONS persistence (Phase 9).
 *
 * The POSIX path uses a marker block in `~/.bashrc` / `~/.zshrc`. Windows
 * has no equivalent shell rc that all Node-launched processes read — cmd,
 * PowerShell, and Win+R-launched .exe all draw env vars from the user
 * registry under HKCU\Environment.
 *
 * `setx NODE_OPTIONS "value"` writes there. New processes pick it up.
 * The current shell does NOT see the change — user has to open a new
 * terminal. Same UX caveat as POSIX.
 *
 * Why not edit PowerShell `$PROFILE`: ExecutionPolicy on locked-down
 * corporate fleets often blocks unsigned `.ps1`. cmd-launched Node
 * processes also miss it. setx is universal across both.
 *
 * Idempotency: we read the persisted NODE_OPTIONS via `reg query` (not
 * `process.env.NODE_OPTIONS`, which is the current-shell value, not the
 * persistent one). If our `--require <auto>` is already present, no-op.
 *
 * Uninstall: backup the user's PRE-modification value to
 * `~/.robot-resources/windows-prior-node-options.txt`. On `--uninstall`,
 * restore from backup; if the backup is missing or empty, clear the var.
 *
 * Truncation note: `setx` truncates values at 1024 chars. If a user
 * already has a long NODE_OPTIONS plus other dev tooling, we may be
 * close to the limit. We surface the merged length in telemetry so we
 * can spot truncation in Supabase.
 */

const REG_PATH = 'HKCU\\Environment';
const VAR_NAME = 'NODE_OPTIONS';
const SETX_LIMIT = 1024;

function backupFilePath(home = homedir()) {
  return join(home, '.robot-resources', 'windows-prior-node-options.txt');
}

/**
 * Read the persisted NODE_OPTIONS value from HKCU\Environment.
 * Returns the string (possibly empty) or null if reading failed.
 */
export function readPersistedNodeOptions() {
  const res = spawnSync(
    'reg.exe',
    ['query', REG_PATH, '/v', VAR_NAME],
    { stdio: 'pipe', encoding: 'utf-8' },
  );
  if (res.status !== 0) {
    // `reg query` returns non-zero when the value doesn't exist. That's a
    // valid state — empty NODE_OPTIONS — not an error.
    const stderr = (res.stderr || '').toLowerCase();
    if (stderr.includes('unable to find') || stderr.includes('not exist')) {
      return '';
    }
    return null;
  }
  // Output looks like:
  //   HKEY_CURRENT_USER\Environment
  //       NODE_OPTIONS    REG_SZ    --require ...
  // We extract the value after REG_SZ. The value can contain spaces; take
  // everything after the last "REG_SZ" occurrence on its line.
  const lines = (res.stdout || '').split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*NODE_OPTIONS\s+REG_(?:SZ|EXPAND_SZ)\s+(.*)$/);
    if (m) return m[1].trim();
  }
  return '';
}

/**
 * Set NODE_OPTIONS in HKCU\Environment to the given value (idempotent
 * append of `--require <autoPath>` to whatever was there).
 *
 * Returns:
 *   { ok: true,  already: boolean, prior: string, written: string, length: number }
 *   { ok: false, reason, error_message? }
 */
export function writePersistedNodeOptions({ autoPath, home = homedir() }) {
  if (!autoPath) {
    return { ok: false, reason: 'missing_auto_path' };
  }

  const prior = readPersistedNodeOptions();
  if (prior === null) {
    return { ok: false, reason: 'reg_query_failed' };
  }

  // Quote the path so a path with spaces survives Node's --require parser.
  // Node accepts both quoted and unquoted forms; quoting is safer.
  const ourArg = `--require "${autoPath}"`;

  if (prior.includes(ourArg) || prior.includes(`--require ${autoPath}`)) {
    return {
      ok: true,
      already: true,
      prior,
      written: prior,
      length: prior.length,
    };
  }

  const merged = prior ? `${prior} ${ourArg}` : ourArg;

  if (merged.length > SETX_LIMIT) {
    // setx truncates silently at 1024 chars. Refuse rather than write a
    // broken value. User must shorten their existing NODE_OPTIONS first.
    return {
      ok: false,
      reason: 'setx_limit_exceeded',
      error_message: `merged value is ${merged.length} chars; setx truncates at ${SETX_LIMIT}`,
      length: merged.length,
    };
  }

  // Backup the prior value BEFORE writing, so --uninstall can restore.
  // Even if backup write fails (disk full, permissions), we still proceed —
  // the registry-level setx is the source of truth, the backup is just a
  // convenience for restore.
  try {
    const backup = backupFilePath(home);
    mkdirSync(join(home, '.robot-resources'), { recursive: true });
    writeFileSync(backup, prior, { encoding: 'utf-8' });
  } catch {
    // Best-effort backup; continue.
  }

  const setxRes = spawnSync(
    'setx.exe',
    [VAR_NAME, merged],
    { stdio: 'pipe', encoding: 'utf-8' },
  );
  if (setxRes.status !== 0) {
    const stderr = (setxRes.stderr || '').toString().trim();
    return {
      ok: false,
      reason: 'setx_failed',
      error_message: stderr.slice(0, 200) || `exit ${setxRes.status}`,
      length: merged.length,
    };
  }

  return {
    ok: true,
    already: false,
    prior,
    written: merged,
    length: merged.length,
  };
}

/**
 * Reverse `writePersistedNodeOptions`. Reads the backup file (if present)
 * and restores that value via setx. If no backup is present or the backup
 * is empty, clears the registry value entirely (`reg delete`).
 *
 * Returns { ok, restored_to: string, action: 'restored'|'cleared'|'noop' }
 */
export function removePersistedNodeOptions({ home = homedir() } = {}) {
  const current = readPersistedNodeOptions();
  if (current === null) return { ok: false, action: 'noop' };
  if (current === '') return { ok: true, restored_to: '', action: 'noop' };

  const backupPath = backupFilePath(home);
  let priorValue = '';
  if (existsSync(backupPath)) {
    try { priorValue = readFileSync(backupPath, 'utf-8'); } catch { /* */ }
  }

  if (priorValue === '') {
    // No prior value to restore — clear the var entirely.
    const res = spawnSync(
      'reg.exe',
      ['delete', REG_PATH, '/v', VAR_NAME, '/f'],
      { stdio: 'pipe', encoding: 'utf-8' },
    );
    if (existsSync(backupPath)) try { unlinkSync(backupPath); } catch { /* */ }
    return {
      ok: res.status === 0,
      restored_to: '',
      action: 'cleared',
    };
  }

  // Restore the prior value.
  const res = spawnSync(
    'setx.exe',
    [VAR_NAME, priorValue],
    { stdio: 'pipe', encoding: 'utf-8' },
  );
  if (existsSync(backupPath)) try { unlinkSync(backupPath); } catch { /* */ }
  return {
    ok: res.status === 0,
    restored_to: priorValue,
    action: 'restored',
  };
}
