import { existsSync, readFileSync, writeFileSync, appendFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Idempotent writer for the NODE_OPTIONS auto-attach line in shell rc files.
 *
 * Phase 3 ships POSIX-only support: zsh, bash, fish. Windows ships a printed-
 * instructions fallback (Phase 6 problem). Every write is wrapped in a
 * marker block so `--uninstall` can find and remove cleanly without
 * regex-matching against the user's actual shell content:
 *
 *     # >>> robot-resources: NODE_OPTIONS auto-attach >>>
 *     export NODE_OPTIONS="${NODE_OPTIONS:-} --require /Users/x/.robot-resources/router/auto.cjs"
 *     # <<< robot-resources <<<
 *
 * Phase 8 fix: NODE_OPTIONS now uses an ABSOLUTE PATH to the auto.cjs the
 * wizard copied to ~/.robot-resources/router/. The previous bare-module
 * form `--require @robot-resources/router/auto` only resolved when the user
 * was cd'd inside a project that had `@robot-resources/router` in its
 * node_modules — and broke EVERY Node command from any other cwd with
 * `Cannot find module`. Result: every wizard-success Node user pre-Phase-8
 * had a NODE_OPTIONS line that crashed `node`/`npm`/etc. Symptom in
 * Supabase: `node_shim_installed: 8` but `adapter_attached: 0`.
 *
 * Behavior decisions (preserved from Phase 3):
 *   - If NODE_OPTIONS is already set with a different --require (rare; e.g.
 *     dd-trace), append ours after theirs. Both load. The user keeps their
 *     existing tooling. The shell expansion `${NODE_OPTIONS:-} ...` handles
 *     this correctly — POSIX shells concat space-separated --require flags.
 *   - Never clobber. If our marker block already exists, it's a no-op.
 *   - Write to ALL detected rc files (e.g. user has both .zshrc + .bashrc),
 *     so the user gets routing in whichever shell they actually open.
 */

const MARK_BEGIN = '# >>> robot-resources: NODE_OPTIONS auto-attach >>>';
const MARK_END = '# <<< robot-resources <<<';

function buildPosixLine(autoPath) {
  return `export NODE_OPTIONS="\${NODE_OPTIONS:-} --require ${autoPath}"`;
}

function buildFishLine(autoPath) {
  // Fish has different syntax (no `export`, uses `set -x`).
  return `set -x NODE_OPTIONS "$NODE_OPTIONS --require ${autoPath}"`;
}

/**
 * Discover which rc files are present for this user. Returns a list of
 * absolute paths in priority order (zsh first, bash second, fish third).
 * The wizard writes to ALL of them — users frequently edit one shell's
 * rc and forget another, and we'd rather over-cover than under-cover.
 */
export function listShellRcFiles(home = homedir()) {
  const candidates = [
    { kind: 'zsh', path: join(home, '.zshrc') },
    { kind: 'bash', path: join(home, '.bashrc') },
    { kind: 'bash', path: join(home, '.bash_profile') }, // macOS often uses this
    { kind: 'fish', path: join(home, '.config', 'fish', 'config.fish') },
  ];
  return candidates.filter((c) => existsSync(c.path));
}

/**
 * Returns true if at least one rc file already has our marker block.
 * Used by both the wizard (skip-if-already-installed) and uninstall
 * (gate the "remove" step).
 */
export function hasShellLine(home = homedir()) {
  for (const { path } of listShellRcFiles(home)) {
    try {
      const text = readFileSync(path, 'utf-8');
      if (text.includes(MARK_BEGIN)) return true;
    } catch { /* unreadable rc, skip */ }
  }
  return false;
}

/**
 * Idempotently append the marker block to every detected rc file. Returns
 * a list of files actually modified (empty if everything already had it).
 *
 * Each rc file is treated independently: the writer never aborts the
 * others on one failure. Per-file errors are returned as warnings the
 * caller can surface.
 */
export function writeShellLine({ autoPath, home = homedir() }) {
  if (!autoPath) {
    throw new Error('writeShellLine requires { autoPath } — absolute path to auto.cjs');
  }

  const rcs = listShellRcFiles(home);
  const written = [];
  const errors = [];

  if (rcs.length === 0) {
    // POSIX shells but no rc file yet — create ~/.zshrc on macOS (default
    // since 10.15), ~/.bashrc on Linux. Better than silently no-op'ing.
    const fallback = process.platform === 'darwin'
      ? { kind: 'zsh', path: join(home, '.zshrc') }
      : { kind: 'bash', path: join(home, '.bashrc') };
    rcs.push(fallback);
  }

  for (const rc of rcs) {
    try {
      let text = '';
      try { text = readFileSync(rc.path, 'utf-8'); } catch { /* file may not exist yet */ }

      if (text.includes(MARK_BEGIN)) {
        // Already installed. Skip silently.
        continue;
      }

      const line = rc.kind === 'fish' ? buildFishLine(autoPath) : buildPosixLine(autoPath);
      const block =
        (text && !text.endsWith('\n') ? '\n' : '') +
        '\n' + MARK_BEGIN + '\n' + line + '\n' + MARK_END + '\n';

      // Append, don't rewrite — preserves the user's content exactly.
      appendFileSync(rc.path, block, { mode: 0o644 });
      written.push(rc.path);
    } catch (err) {
      errors.push({ path: rc.path, message: err.message });
    }
  }

  return { written, errors };
}

/**
 * Idempotently REMOVE the marker block from every detected rc file.
 * Mirror of writeShellLine. Returns a list of files actually modified.
 *
 * Removal is text-based (find MARK_BEGIN, find MARK_END, splice). If the
 * block was tampered with — e.g. user manually deleted MARK_END — we leave
 * the file alone and surface a warning. Never destructive on partial state.
 */
export function removeShellLine(home = homedir()) {
  const rcs = listShellRcFiles(home);
  const removed = [];
  const errors = [];

  for (const rc of rcs) {
    try {
      const text = readFileSync(rc.path, 'utf-8');
      const startIdx = text.indexOf(MARK_BEGIN);
      if (startIdx === -1) continue;
      const endIdx = text.indexOf(MARK_END, startIdx);
      if (endIdx === -1) {
        errors.push({ path: rc.path, message: 'marker_end_missing' });
        continue;
      }

      // Splice from MARK_BEGIN through end of MARK_END line + trailing newline.
      const afterEnd = text.indexOf('\n', endIdx);
      const sliceEnd = afterEnd === -1 ? text.length : afterEnd + 1;

      // Walk back over the leading newline our writer added so we don't
      // accumulate blank lines on repeated install/uninstall cycles.
      let sliceStart = startIdx;
      while (sliceStart > 0 && text[sliceStart - 1] === '\n') sliceStart--;

      const next = text.slice(0, sliceStart) +
        (sliceStart > 0 ? '\n' : '') +
        text.slice(sliceEnd);

      writeFileSync(rc.path, next, { mode: getMode(rc.path) });
      removed.push(rc.path);
    } catch (err) {
      errors.push({ path: rc.path, message: err.message });
    }
  }

  return { removed, errors };
}

function getMode(path) {
  try { return statSync(path).mode & 0o777; } catch { return 0o644; }
}

// Exported for tests + telemetry payloads.
export { MARK_BEGIN, MARK_END, buildPosixLine, buildFishLine };
