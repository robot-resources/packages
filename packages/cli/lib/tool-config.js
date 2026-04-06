import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { isOpenClawInstalled, isOpenClawPluginInstalled, getOpenClawAuthMode } from './detect.js';
import { stripJson5 } from './json5.js';

/**
 * Read openclaw.json, creating it with a minimal structure if it doesn't exist.
 * Returns parsed config object. Throws on malformed JSON (caller handles).
 */
function readOrCreateOpenClawConfig() {
  const configDir = join(homedir(), '.openclaw');
  const configPath = join(configDir, 'openclaw.json');

  if (!existsSync(configPath)) {
    mkdirSync(configDir, { recursive: true });
    const minimal = {};
    writeFileSync(configPath, JSON.stringify(minimal, null, 2) + '\n', 'utf-8');
    return minimal;
  }

  const raw = readFileSync(configPath, 'utf-8');
  return JSON.parse(stripJson5(raw));
}

/**
 * Trust the Robot Resources plugin in OpenClaw config.
 *
 * Adds "openclaw-plugin" to plugins.allow so OpenClaw loads it without
 * provenance warnings. The plugin's before_model_resolve hook intercepts
 * ALL LLM calls regardless of the default model — no need to change the
 * default model (which causes LiveSessionModelSwitchError in OC).
 *
 * Returns true if the config was updated, false otherwise.
 */
function trustPlugin() {
  const configPath = join(homedir(), '.openclaw', 'openclaw.json');

  try {
    const config = readOrCreateOpenClawConfig();

    if (!config.plugins) config.plugins = {};
    if (!Array.isArray(config.plugins.allow)) config.plugins.allow = [];

    if (config.plugins.allow.includes('openclaw-plugin')) {
      return false;
    }

    config.plugins.allow.push('openclaw-plugin');

    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Register scraper-mcp as an MCP server in openclaw.json.
 *
 * This makes scraper_compress_url and scraper_crawl_url available
 * as native tools in OpenClaw. The plugin's before_tool_call hook
 * then intercepts web_fetch to route through the scraper by default.
 *
 * Returns true if the config was updated, false otherwise.
 */
function registerScraperMcp() {
  const configPath = join(homedir(), '.openclaw', 'openclaw.json');

  try {
    const config = readOrCreateOpenClawConfig();

    if (!config.mcp) config.mcp = {};
    if (!config.mcp.servers) config.mcp.servers = {};

    // Already registered
    if (config.mcp.servers['robot-resources-scraper']) {
      return false;
    }

    config.mcp.servers['robot-resources-scraper'] = {
      command: 'npx',
      args: ['-y', '-p', '@robot-resources/scraper', 'scraper-mcp'],
    };

    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    return true;
  } catch {
    // Config missing or malformed — non-fatal
    return false;
  }
}

/**
 * Copy the bundled plugin files to ~/.openclaw/extensions/openclaw-plugin/.
 *
 * The plugin ships as a CLI dependency (@robot-resources/openclaw-plugin).
 * Instead of spawning `openclaw plugins install` (30s npm overhead),
 * we copy the 3 files directly. Same destination, same result.
 */
function installPluginFiles() {
  const require = createRequire(import.meta.url);
  const pluginPkgPath = require.resolve('@robot-resources/openclaw-plugin/package.json');
  const pluginDir = dirname(pluginPkgPath);

  const targetDir = join(homedir(), '.openclaw', 'extensions', 'openclaw-plugin');
  mkdirSync(targetDir, { recursive: true });

  for (const file of ['index.js', 'openclaw.plugin.json', 'package.json']) {
    copyFileSync(join(pluginDir, file), join(targetDir, file));
  }
}

/**
 * Register the plugin in openclaw.json so OC loads it on gateway start.
 * Adds plugins.entries.openclaw-plugin = { enabled: true }.
 */
function registerPluginEntry() {
  const configPath = join(homedir(), '.openclaw', 'openclaw.json');

  try {
    const config = readOrCreateOpenClawConfig();

    if (!config.plugins) config.plugins = {};
    if (!config.plugins.entries) config.plugins.entries = {};

    // Already registered
    if (config.plugins.entries['openclaw-plugin']) return;

    config.plugins.entries['openclaw-plugin'] = { enabled: true };

    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  } catch {
    // Non-fatal — plugin may still auto-load from extensions dir
  }
}

/**
 * Configure OpenClaw to route through Robot Resources Router.
 *
 * Copies the bundled @robot-resources/openclaw-plugin files into
 * ~/.openclaw/extensions/. The plugin uses before_model_resolve to
 * override the provider — survives gateway restarts because it
 * lives in ~/.openclaw/extensions/, not in openclaw.json.
 *
 * Auth mode detection:
 * - subscription (OAuth token): Plugin is REQUIRED. Anthropic rejects
 *   OAuth tokens from third-party clients, so HTTP proxy won't work.
 * - apikey: Plugin is preferred (survives restarts) but proxy also works.
 */
function configureOpenClaw() {
  const authMode = getOpenClawAuthMode();

  if (isOpenClawPluginInstalled()) {
    return {
      name: 'OpenClaw',
      action: 'already_configured',
      authMode,
    };
  }

  try {
    installPluginFiles();

    // Register plugin in openclaw.json so OC loads it on gateway start.
    registerPluginEntry();

    // Trust the plugin so OC loads it without provenance warnings.
    const configActivated = trustPlugin();

    return {
      name: 'OpenClaw',
      action: 'installed',
      authMode,
      configActivated,
      note: authMode === 'subscription'
        ? 'Plugin required — subscription OAuth tokens are rejected by Anthropic when proxied via third-party clients.'
        : undefined,
    };
  } catch {
    // Plugin file copy failed — fall back to instructions
    const instructions = [
      'Could not auto-install plugin. Install manually:',
      '  openclaw plugins install @robot-resources/openclaw-plugin',
    ];

    if (authMode === 'subscription') {
      instructions.push(
        'IMPORTANT: Subscription mode detected (OAuth token).',
        'The plugin is required — HTTP proxy cannot forward OAuth tokens.',
        'Anthropic rejects OAuth tokens from third-party clients.',
      );
    }

    instructions.push('Docs: https://github.com/robot-resources/robot-resources');

    return {
      name: 'OpenClaw',
      action: 'instructions',
      authMode,
      instructions,
    };
  }
}

/**
 * Configure all detected AI tools to route through the Router.
 *
 * Returns array of { name, action, ... } results.
 */
export function configureToolRouting() {
  const results = [];

  // OpenClaw
  if (isOpenClawInstalled()) {
    results.push(configureOpenClaw());
  }

  return results;
}

/**
 * Run a command with a heartbeat to keep agent sessions alive.
 * OC kills processes after 5s of no output (noOutputTimeoutMs = 5000).
 * Prints immediately, then every 4s (safely under the 5s threshold).
 */
function spawnWithHeartbeat(cmd, args, { label, timeout = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
    });

    process.stdout.write(`  ${label}...\n`);
    let seconds = 0;
    const heartbeat = setInterval(() => {
      seconds += 4;
      process.stdout.write(`  ${label}... ${seconds}s\n`);
    }, 4000);

    proc.on('close', (code) => {
      clearInterval(heartbeat);
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
    });

    proc.on('error', (err) => {
      clearInterval(heartbeat);
      reject(err);
    });
  });
}

/**
 * Restart the OpenClaw gateway so it picks up new plugin + config.
 * Uses heartbeat to keep OC sessions alive during the restart.
 * Telegram survives this restart — tested end-to-end (PR #89).
 */
async function restartOpenClawGateway() {
  await spawnWithHeartbeat('openclaw', ['gateway', 'restart'], {
    label: 'Restarting gateway',
    timeout: 15_000,
  });
}

// Exported for testing and direct use
export { stripJson5, configureOpenClaw, registerScraperMcp, restartOpenClawGateway };
