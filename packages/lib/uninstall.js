import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stripJson5 } from './json5.js';

/**
 * Single source of truth for `npx robot-resources --uninstall`.
 *
 * Reverses the install actions in tool-config.js: removes the router and
 * scraper OC plugin directories, deletes their entries from openclaw.json
 * (plugins.entries + plugins.allow + mcp.servers).
 *
 * Phase 0 scope is OC-only. Phase 3 will extend this with shell-config
 * removal (NODE_OPTIONS line) and `pip uninstall robot-resources` for the
 * Node and Python shim install paths.
 *
 * `~/.robot-resources/config.json` is preserved by default so a subsequent
 * re-install reuses the same api_key (and the user's claim_url stays valid).
 * Pass { purge: true } to wipe it as well.
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

  // 3. Optionally wipe ~/.robot-resources/config.json (and any siblings)
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
