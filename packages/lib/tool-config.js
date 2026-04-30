import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, copyFileSync, cpSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { isOpenClawInstalled, isOpenClawPluginInstalled, isScraperOcPluginInstalled, getOpenClawAuthMode, isClaudeCodeInstalled, isCursorInstalled } from './detect.js';
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
 * Adds "robot-resources-router" to plugins.allow so OpenClaw loads it without
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

    if (config.plugins.allow.includes('robot-resources-router')) {
      return false;
    }

    config.plugins.allow.push('robot-resources-router');

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
 * Copy the bundled plugin files to ~/.openclaw/extensions/robot-resources-router/.
 *
 * The plugin ships as a CLI dependency (@robot-resources/router — the
 * router IS the OC plugin in the in-process architecture).
 * Instead of spawning `openclaw plugins install` (30s npm overhead),
 * we copy files directly. Same destination, same result.
 *
 * The plugin is a thin shim (index.js) that imports the rest
 * of its code from ./lib/*.js — copy the lib/ directory too, or the shim
 * fails to load with MODULE_NOT_FOUND.
 */
function installPluginFiles() {
  const require = createRequire(import.meta.url);
  const pluginPkgPath = require.resolve('@robot-resources/router/package.json');
  const pluginDir = dirname(pluginPkgPath);

  const targetDir = join(homedir(), '.openclaw', 'extensions', 'robot-resources-router');
  mkdirSync(targetDir, { recursive: true });

  for (const file of ['index.js', 'openclaw.plugin.json', 'package.json']) {
    copyFileSync(join(pluginDir, file), join(targetDir, file));
  }

  // Copy lib/ recursively. Clear the destination first so files removed in
  // a new version don't linger from a previous install.
  const srcLib = join(pluginDir, 'lib');
  const dstLib = join(targetDir, 'lib');
  if (existsSync(srcLib)) {
    rmSync(dstLib, { recursive: true, force: true });
    cpSync(srcLib, dstLib, { recursive: true });
  }
}

/**
 * Register the plugin in openclaw.json so OC loads it on gateway start.
 * Adds plugins.entries.robot-resources-router = { enabled: true }.
 */
function registerPluginEntry() {
  const configPath = join(homedir(), '.openclaw', 'openclaw.json');

  try {
    const config = readOrCreateOpenClawConfig();

    if (!config.plugins) config.plugins = {};
    if (!config.plugins.entries) config.plugins.entries = {};

    // Already registered
    if (config.plugins.entries['robot-resources-router']) return;

    config.plugins.entries['robot-resources-router'] = { enabled: true };

    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  } catch {
    // Non-fatal — plugin may still auto-load from extensions dir
  }
}

/**
 * Trust the scraper OC plugin in OpenClaw config.
 *
 * Adds "robot-resources-scraper-oc-plugin" to plugins.allow so OpenClaw
 * loads it without provenance warnings. The plugin's before_tool_call
 * hook redirects web_fetch to scraper_compress_url.
 *
 * Returns true if the config was updated, false otherwise.
 */
function trustScraperOcPlugin() {
  const configPath = join(homedir(), '.openclaw', 'openclaw.json');

  try {
    const config = readOrCreateOpenClawConfig();

    if (!config.plugins) config.plugins = {};
    if (!Array.isArray(config.plugins.allow)) config.plugins.allow = [];

    if (config.plugins.allow.includes('robot-resources-scraper-oc-plugin')) {
      return false;
    }

    config.plugins.allow.push('robot-resources-scraper-oc-plugin');

    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy the bundled scraper OC plugin files to
 * ~/.openclaw/extensions/robot-resources-scraper-oc-plugin/.
 *
 * Mirrors installPluginFiles() but for the scraper OC plugin package.
 */
function installScraperOcPluginFiles() {
  const require = createRequire(import.meta.url);
  // OC plugin lives as a subfolder inside the scraper package post-consolidation.
  const scraperPkgPath = require.resolve('@robot-resources/scraper/package.json');
  const pluginDir = join(dirname(scraperPkgPath), 'oc-plugin');

  const targetDir = join(homedir(), '.openclaw', 'extensions', 'robot-resources-scraper-oc-plugin');
  mkdirSync(targetDir, { recursive: true });

  for (const file of ['index.js', 'openclaw.plugin.json', 'package.json']) {
    copyFileSync(join(pluginDir, file), join(targetDir, file));
  }

  // Copy lib/ recursively. Clear destination first so files removed in
  // a new version don't linger from a previous install.
  const srcLib = join(pluginDir, 'lib');
  const dstLib = join(targetDir, 'lib');
  if (existsSync(srcLib)) {
    rmSync(dstLib, { recursive: true, force: true });
    cpSync(srcLib, dstLib, { recursive: true });
  }
}

/**
 * Register the scraper OC plugin in openclaw.json so OC loads it on
 * gateway start. Adds plugins.entries['robot-resources-scraper-oc-plugin'] = { enabled: true }.
 */
function registerScraperOcPluginEntry() {
  const configPath = join(homedir(), '.openclaw', 'openclaw.json');

  try {
    const config = readOrCreateOpenClawConfig();

    if (!config.plugins) config.plugins = {};
    if (!config.plugins.entries) config.plugins.entries = {};

    if (config.plugins.entries['robot-resources-scraper-oc-plugin']) return;

    config.plugins.entries['robot-resources-scraper-oc-plugin'] = { enabled: true };

    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  } catch {
    // Non-fatal — plugin may still auto-load from extensions dir
  }
}

/**
 * Configure OpenClaw to route through Robot Resources Router.
 *
 * Copies the bundled @robot-resources/router files into
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

  const routerWasInstalled = isOpenClawPluginInstalled();
  const scraperWasInstalled = isScraperOcPluginInstalled();

  if (routerWasInstalled && scraperWasInstalled) {
    return {
      name: 'OpenClaw',
      action: 'already_configured',
      authMode,
    };
  }

  try {
    let configActivated = false;

    if (!routerWasInstalled) {
      installPluginFiles();
      registerPluginEntry();
      configActivated = trustPlugin();
    }

    if (!scraperWasInstalled) {
      installScraperOcPluginFiles();
      registerScraperOcPluginEntry();
      // OR-combine so configActivated reflects "any plugin entry was added to allow".
      configActivated = trustScraperOcPlugin() || configActivated;
    }

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
      '  openclaw plugins install @robot-resources/router',
    ];

    if (authMode === 'subscription') {
      instructions.push(
        'IMPORTANT: Subscription mode detected (OAuth token).',
        'The plugin is required — HTTP proxy cannot forward OAuth tokens.',
        'Anthropic rejects OAuth tokens from third-party clients.',
      );
    }

    instructions.push('Docs: https://github.com/robot-resources/packages');

    return {
      name: 'OpenClaw',
      action: 'instructions',
      authMode,
      instructions,
    };
  }
}

/**
 * Generate copy-pasteable SDK configuration instructions.
 *
 * Returned when no AI tools are auto-detected. Gives the developer
 * exactly what they need to point their SDK at the router manually.
 */
function printManualInstructions() {
  return {
    name: 'Manual Configuration',
    action: 'instructions',
    instructions: [
      'No AI tools detected for auto-configuration.',
      'Point your SDK at the Router by setting the base URL:',
      '',
      '  # OpenAI SDK / compatible clients (include /v1 in the URL)',
      '  export OPENAI_BASE_URL=http://localhost:3838/v1',
      '  #   OpenAI(base_url="http://localhost:3838/v1")',
      '',
      '  # Anthropic SDK (NO /v1 — the SDK appends /v1/messages itself)',
      '  export ANTHROPIC_BASE_URL=http://localhost:3838',
      '  #   Anthropic(base_url="http://localhost:3838")',
      '',
      '  # Google / Gemini: native SDK is NOT supported via base_url.',
      '  # Use the OpenAI-compatible client with a Gemini model name:',
      '  #   OpenAI(base_url="http://localhost:3838/v1")',
      '  #   model = "gemini-2.5-flash"',
      '',
      'Docs: https://github.com/robot-resources/packages',
    ],
  };
}

/**
 * Configure Claude Code to use the Router as an MCP server.
 *
 * Writes a robot-resources-router entry to ~/.claude/settings.json
 * under the mcpServers key. Claude Code reads this on startup.
 */
function configureClaudeCode() {
  const configPath = join(homedir(), '.claude', 'settings.json');

  try {
    let config = {};
    if (existsSync(configPath)) {
      config = JSON.parse(readFileSync(configPath, 'utf-8'));
    }

    if (!config.mcpServers) config.mcpServers = {};

    if (config.mcpServers['robot-resources-router']) {
      return { name: 'Claude Code', action: 'already_configured' };
    }

    config.mcpServers['robot-resources-router'] = {
      command: 'npx',
      args: ['-y', '@robot-resources/router', 'mcp'],
    };

    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    return { name: 'Claude Code', action: 'configured' };
  } catch {
    return {
      name: 'Claude Code',
      action: 'instructions',
      instructions: [
        'Could not auto-configure Claude Code. Add manually to ~/.claude/settings.json:',
        '  "mcpServers": { "robot-resources-router": { "command": "npx", "args": ["-y", "@robot-resources/router", "mcp"] } }',
      ],
    };
  }
}

/**
 * Configure Cursor to use the Router as an MCP server.
 *
 * Writes a robot-resources-router entry to ~/.cursor/mcp.json
 * under the mcpServers key. Cursor reads this on startup.
 */
function configureCursor() {
  const configPath = join(homedir(), '.cursor', 'mcp.json');

  try {
    let config = {};
    if (existsSync(configPath)) {
      config = JSON.parse(readFileSync(configPath, 'utf-8'));
    }

    if (!config.mcpServers) config.mcpServers = {};

    if (config.mcpServers['robot-resources-router']) {
      return { name: 'Cursor', action: 'already_configured' };
    }

    config.mcpServers['robot-resources-router'] = {
      command: 'npx',
      args: ['-y', '@robot-resources/router', 'mcp'],
    };

    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    return { name: 'Cursor', action: 'configured' };
  } catch {
    return {
      name: 'Cursor',
      action: 'instructions',
      instructions: [
        'Could not auto-configure Cursor. Add manually to ~/.cursor/mcp.json:',
        '  "mcpServers": { "robot-resources-router": { "command": "npx", "args": ["-y", "@robot-resources/router", "mcp"] } }',
      ],
    };
  }
}

/**
 * Configure all detected AI tools to route through the Router.
 *
 * Returns array of { name, action, ... } results.
 * When no tools are detected, returns manual SDK instructions.
 */
export function configureToolRouting() {
  const results = [];

  // OpenClaw
  if (isOpenClawInstalled()) {
    results.push(configureOpenClaw());
  }

  // Claude Code
  if (isClaudeCodeInstalled()) {
    results.push(configureClaudeCode());
  }

  // Cursor
  if (isCursorInstalled()) {
    results.push(configureCursor());
  }

  // Fallback: manual SDK instructions when no tools detected
  if (results.length === 0) {
    results.push(printManualInstructions());
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
export { stripJson5, configureOpenClaw, configureClaudeCode, configureCursor, registerScraperMcp, restartOpenClawGateway };
