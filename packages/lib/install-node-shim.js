import { writeShellLine, hasShellLine } from './shell-config.js';
import { readConfig } from './config.mjs';
import { detectNodeAgent } from './detect.js';
import { installRouterFiles } from './install-router-files.js';

const PLATFORM_URL = process.env.RR_PLATFORM_URL || 'https://api.robotresources.ai';

/**
 * Install the Node shim into the user's shell config. Phase 3 entry for
 * the non-OC Node path.
 *
 * Steps:
 *   1. Copy the bundled `@robot-resources/router` files to a stable absolute
 *      path under `~/.robot-resources/router/` (mirrors the OC plugin pattern
 *      at `~/.openclaw/extensions/`). Phase 8 fix: previously NODE_OPTIONS
 *      used the bare module name `@robot-resources/router/auto` which only
 *      resolved when the user was cd'd inside a project that had the
 *      package in its node_modules. From any other cwd, EVERY `node`
 *      command crashed with "Cannot find module".
 *   2. Append the marker block to detected rc files (zsh / bash / fish)
 *      with the ABSOLUTE PATH to the copied auto.cjs.
 *   3. Emit `node_shim_installed` telemetry.
 *
 * The user has to start a new shell (or `source` the file) for the
 * NODE_OPTIONS to take effect — we tell them this in the wizard's
 * post-install message.
 *
 * Windows: shell-config.writeShellLine returns no rc files on Windows
 * (we only support POSIX in P3). The wizard prints manual instructions
 * for Windows users in `non-oc-wizard.js`.
 *
 * Returns a UI-friendly result the wizard can format and print.
 */
export async function installNodeShim({ cwd = process.cwd(), dryRun = false } = {}) {
  if (process.platform === 'win32') {
    await emit({
      shell: 'unsupported',
      shell_config_path: null,
      sdks_detected: detectSdks(cwd),
      dry_run: dryRun,
      reason: 'windows_not_supported_yet',
    });
    return {
      ok: false,
      reason: 'windows_not_supported_yet',
      message:
        'Windows shell-config writing is not yet supported. Set ' +
        'NODE_OPTIONS to point at ~/.robot-resources/router/auto.cjs manually ' +
        'in your system environment variables, or wait for Phase 6.',
    };
  }

  const sdks = detectSdks(cwd);

  if (dryRun) {
    await emit({
      shell: 'dryrun',
      shell_config_path: null,
      sdks_detected: sdks,
      dry_run: true,
      reason: null,
    });
    return { ok: true, message: 'Dry-run: would have written NODE_OPTIONS to shell rc.' };
  }

  // Phase 8: copy router to an absolute path under ~/.robot-resources/router/
  // before we wire the shell config. If the copy fails, we don't write a
  // broken NODE_OPTIONS line.
  let autoPath;
  try {
    autoPath = installRouterFiles();
  } catch (err) {
    await emit({
      shell: 'unknown',
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
