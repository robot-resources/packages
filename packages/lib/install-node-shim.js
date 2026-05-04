import { writeShellLine, hasShellLine } from './shell-config.js';
import { readConfig } from './config.mjs';
import { detectNodeAgent } from './detect.js';
import { installRouterFiles } from './install-router-files.js';
import { writePersistedNodeOptions } from './windows-env.js';

const PLATFORM_URL = process.env.RR_PLATFORM_URL || 'https://api.robotresources.ai';

/**
 * Install the Node shim into the user's shell config (POSIX) or user
 * environment registry (Windows).
 *
 * POSIX path (Phases 3 + 8):
 *   1. Copy `@robot-resources/router` to ~/.robot-resources/router/
 *      (absolute path; survives cwd changes + npm/npx cache cleanup).
 *   2. Append marker block with `--require <abs path>` to detected rc files
 *      (zsh / bash / fish).
 *
 * Windows path (Phase 9):
 *   1. Same router-files copy — `homedir()` is platform-aware.
 *   2. `setx NODE_OPTIONS "..."` writes to HKCU\\Environment so every new
 *      cmd / PowerShell / Win+R-launched Node process inherits it.
 *
 * Both paths emit `node_shim_installed` telemetry. The user has to open a
 * new terminal for the change to take effect.
 *
 * Returns a UI-friendly result the wizard can format and print.
 */
export async function installNodeShim({ cwd = process.cwd(), dryRun = false } = {}) {
  const sdks = detectSdks(cwd);

  if (dryRun) {
    await emit({
      shell: 'dryrun',
      shell_config_path: null,
      sdks_detected: sdks,
      dry_run: true,
      reason: null,
    });
    return { ok: true, message: 'Dry-run: would have written NODE_OPTIONS.' };
  }

  // Phase 8: copy router to an absolute path under ~/.robot-resources/router/
  // before we wire the env config. If the copy fails, we don't write a
  // broken NODE_OPTIONS line on either platform.
  let autoPath;
  try {
    autoPath = installRouterFiles();
  } catch (err) {
    await emit({
      shell: process.platform === 'win32' ? 'win32' : 'unknown',
      shell_config_path: null,
      sdks_detected: sdks,
      dry_run: false,
      reason: 'router_copy_failed',
      error_messages: [err.message],
    });
    return {
      ok: false,
      message: `Could not copy router files to ~/.robot-resources/router/: ${err.message}`,
    };
  }

  // Windows branch — Phase 9. Mirrors the POSIX flow in shape: detect
  // already-installed via the persisted registry value, write via setx,
  // emit equivalent telemetry.
  if (process.platform === 'win32') {
    const winResult = writePersistedNodeOptions({ autoPath });
    await emit({
      shell: 'win32',
      shell_config_path: 'HKCU\\Environment\\NODE_OPTIONS',
      sdks_detected: sdks,
      dry_run: false,
      already_installed: !!winResult.already,
      files_written: winResult.ok && !winResult.already ? 1 : 0,
      files_with_errors: winResult.ok ? 0 : 1,
      error_messages: winResult.ok ? [] : [winResult.error_message || winResult.reason || 'unknown'],
      auto_path: autoPath,
      win_node_options_length: winResult.length,
      reason: winResult.ok ? null : winResult.reason,
    });
    if (winResult.ok && winResult.already) {
      return {
        ok: true,
        already: true,
        message: 'NODE_OPTIONS already includes the auto-attach line. No changes made.',
      };
    }
    if (!winResult.ok) {
      return {
        ok: false,
        reason: winResult.reason,
        message: `Could not set NODE_OPTIONS via setx (${winResult.reason}): ${winResult.error_message || ''}`,
      };
    }
    return {
      ok: true,
      written: ['HKCU\\Environment\\NODE_OPTIONS'],
      errors: [],
      message:
        'Set NODE_OPTIONS in your user environment (HKCU\\Environment). ' +
        'Open a new terminal for it to take effect. Existing terminals will not see the change.',
    };
  }

  const alreadyInstalled = hasShellLine();
  const result = writeShellLine({ autoPath });

  // Single shell value for the funnel even though we may have written to
  // multiple rc files. Pick the dominant one for telemetry.
  const dominant = pickDominantShell(result.written);

  await emit({
    shell: dominant,
    shell_config_path: result.written.join(','),
    sdks_detected: sdks,
    dry_run: false,
    already_installed: alreadyInstalled,
    files_written: result.written.length,
    files_with_errors: result.errors.length,
    error_messages: result.errors.map((e) => `${e.path}: ${e.message}`).slice(0, 3),
    auto_path: autoPath,
  });

  if (alreadyInstalled && result.written.length === 0) {
    return {
      ok: true,
      already: true,
      message: 'NODE_OPTIONS auto-attach already installed. No changes made.',
    };
  }

  if (result.written.length === 0 && result.errors.length > 0) {
    return {
      ok: false,
      message: `Could not write to any shell rc file. Errors: ${result.errors.map((e) => e.message).join(', ')}`,
    };
  }

  return {
    ok: true,
    written: result.written,
    errors: result.errors,
    message:
      `Installed NODE_OPTIONS auto-attach in ${result.written.length} shell file(s). ` +
      'Open a new terminal (or source the file) for it to take effect.',
  };
}

function detectSdks(cwd) {
  const result = detectNodeAgent(cwd);
  return result?.evidence ?? [];
}

function pickDominantShell(paths) {
  // Use process.env.SHELL as the tiebreaker — that's the user's actual
  // login shell. Fall back to the first written file's basename.
  const shellEnv = (process.env.SHELL || '').toLowerCase();
  if (shellEnv.includes('zsh')) return 'zsh';
  if (shellEnv.includes('fish')) return 'fish';
  if (shellEnv.includes('bash')) return 'bash';
  if (paths[0]?.endsWith('.zshrc')) return 'zsh';
  if (paths[0]?.endsWith('.bashrc') || paths[0]?.endsWith('.bash_profile')) return 'bash';
  if (paths[0]?.endsWith('config.fish')) return 'fish';
  return 'unknown';
}

async function emit(payload) {
  const config = readConfig();
  if (!config.api_key) return;
  try {
    await fetch(`${PLATFORM_URL}/v1/telemetry`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.api_key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        product: 'cli',
        event_type: 'node_shim_installed',
        payload: { ...payload, platform: process.platform },
      }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // Best-effort — never let telemetry break the install path.
  }
}
