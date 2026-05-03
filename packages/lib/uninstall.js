import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stripJson5 } from './json5.js';
import { removeShellLine } from './shell-config.js';
import { detectVenv } from './venv-detect.js';
import { spawnSync } from 'node:child_process';

/**
 * Single source of truth for `npx robot-resources --uninstall`.
 *
 * Reverses every install path the wizard might have taken:
 *   1. OC plugin directories under ~/.openclaw/extensions/ (Phase 0)
 *   2. Our entries in openclaw.json (plugins.entries + plugins.allow +
 *      mcp.servers) (Phase 0)
 *   3. NODE_OPTIONS marker block in shell rc files (Phase 3 — Node shim)
 *   4. `robot-resources` PyPI package in the resolved venv (Phase 3 —
 *      Python shim)
 *   5. With --purge: ~/.robot-resources/ config dir (api_key + claim_url)
 *
 * `~/.robot-resources/config.json` is preserved by default so a subsequent
 * re-install reuses the same api_key (and the user's claim_url stays valid).
 *
 * Returns { components_removed: string[], errors: { component, message }[] }
 * for telemetry. Failure to remove one component never aborts the others —
 * a partial uninstall is still progress, and we want to record what worked.
 */
export function runUninstall({ purge = false } = {}) {
  const components_removed = [];
  const errors = [];

  // 1. Plugin directories under ~/.openclaw/extensions/
  const pluginDirs = [
    { id: 'robot-resources-router', label: 'router_plugin_dir' },
    { id: 'robot-resources-scraper-oc-plugin', label: 'scraper_plugin_dir' },
  ];
  for (const { id, label } of pluginDirs) {
    const path = join(homedir(), '.openclaw', 'extensions', id);
    if (!existsSync(path)) continue;
    try {
      rmSync(path, { recursive: true, force: true });
      components_removed.push(label);
    } catch (err) {
      errors.push({ component: label, message: err.message });
    }
  }

  // 2. openclaw.json — strip our entries from plugins.entries, plugins.allow,
  //    and mcp.servers. Leave everything else (other plugins, user config) alone.
  //    Idempotent: if openclaw.json is missing or malformed, skip silently —
  //    that's the right behavior for "cleanup what you can find."
  const ocConfigPath = join(homedir(), '.openclaw', 'openclaw.json');
  if (existsSync(ocConfigPath)) {
    try {
      const config = JSON.parse(stripJson5(readFileSync(ocConfigPath, 'utf-8')));
      let mutated = false;

      if (config?.plugins?.entries) {
        for (const id of ['robot-resources-router', 'robot-resources-scraper-oc-plugin']) {
          if (config.plugins.entries[id]) {
            delete config.plugins.entries[id];
            mutated = true;
          }
        }
      }

      if (Array.isArray(config?.plugins?.allow)) {
        const before = config.plugins.allow.length;
        config.plugins.allow = config.plugins.allow.filter(
          (id) => id !== 'robot-resources-router' && id !== 'robot-resources-scraper-oc-plugin',
        );
        if (config.plugins.allow.length !== before) mutated = true;
      }

      if (config?.mcp?.servers?.['robot-resources-scraper']) {
        delete config.mcp.servers['robot-resources-scraper'];
        mutated = true;
      }

      if (mutated) {
        writeFileSync(ocConfigPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
        components_removed.push('openclaw_config_entries');
      }
    } catch (err) {
      errors.push({ component: 'openclaw_config_entries', message: err.message });
    }
  }

  // 3. Shell config — remove the NODE_OPTIONS marker block from any rc
  //    files Phase 3's wizard wrote to. Idempotent: no-op if not present.
  try {
    const result = removeShellLine();
    if (result.removed.length > 0) {
      components_removed.push('shell_config_node_options');
    }
    for (const e of result.errors) {
      errors.push({ component: 'shell_config_node_options', message: `${e.path}: ${e.message}` });
    }
  } catch (err) {
    errors.push({ component: 'shell_config_node_options', message: err.message });
  }

  // 3b. Copied router dir at ~/.robot-resources/router/ (Phase 8). The shell
  //     line points at this absolute path — once the line is gone, the
  //     copied files are dead weight. Remove them.
  const routerDir = join(homedir(), '.robot-resources', 'router');
  if (existsSync(routerDir)) {
    try {
      rmSync(routerDir, { recursive: true, force: true });
      components_removed.push('node_shim_router_dir');
    } catch (err) {
      errors.push({ component: 'node_shim_router_dir', message: err.message });
    }
  }

  // 4. Python shim — `pip uninstall -y robot-resources` against the resolved
  //    venv. Skip silently if no venv detected (the user may have installed
  //    via the wizard but already deleted the venv themselves).
  try {
    const venv = detectVenv();
    if (venv.python) {
      const result = spawnSync(venv.python, ['-m', 'pip', 'uninstall', '-y', 'robot-resources'], {
        encoding: 'utf-8',
        timeout: 60_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      // pip exits 0 if removed, non-zero if package wasn't installed (also acceptable)
      if (result.status === 0) {
        components_removed.push('pip_robot_resources');
      } else if (result.stderr && /not installed|skipping/i.test(result.stderr)) {
        // Already gone — count as success silently.
      } else if (result.status !== null) {
        // Some other failure; record but don't abort
        errors.push({
          component: 'pip_robot_resources',
          message: `pip exit ${result.status}: ${(result.stderr || '').slice(-200)}`,
        });
      }
    }
  } catch (err) {
    errors.push({ component: 'pip_robot_resources', message: err.message });
  }

  // 5. Optionally wipe ~/.robot-resources/config.json (and any siblings)
  if (purge) {
    const rrDir = join(homedir(), '.robot-resources');
    if (existsSync(rrDir)) {
      try {
        rmSync(rrDir, { recursive: true, force: true });
        components_removed.push('rr_config_dir');
      } catch (err) {
        errors.push({ component: 'rr_config_dir', message: err.message });
      }
    }
  }

  return { components_removed, errors };
}
