import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stripJson5 } from './json5.js';

/**
 * Check if OpenClaw is installed.
 */
export function isOpenClawInstalled() {
  const home = homedir();
  return existsSync(join(home, '.openclaw')) || existsSync(join(home, 'openclaw.json'));
}

/**
 * Check if the Robot Resources OpenClaw plugin is already installed.
 */
export function isOpenClawPluginInstalled() {
  const home = homedir();
  const extDir = join(home, '.openclaw', 'extensions');
  return existsSync(join(extDir, 'openclaw-plugin'))
    || existsSync(join(extDir, 'robot-resources-router'));
}

/**
 * Check if the Robot Resources scraper OC plugin is already installed.
 */
export function isScraperOcPluginInstalled() {
  const home = homedir();
  const extDir = join(home, '.openclaw', 'extensions');
  return existsSync(join(extDir, 'robot-resources-scraper-oc-plugin'));
}

/**
 * Detect OpenClaw auth mode: 'subscription' (OAuth token) or 'apikey'.
 *
 * Subscription users authenticate via Anthropic OAuth tokens.
 * Anthropic rejects these tokens from third-party clients, so the
 * only viable routing path is the OpenClaw plugin (not HTTP proxy).
 *
 * Detection order:
 * 1. ANTHROPIC_AUTH_TOKEN env var → subscription
 * 2. openclaw.json config:
 *    a. auth.type === 'oauth' | 'subscription' → subscription
 *    b. auth.profiles.*.mode === 'token' → subscription
 *    c. gateway.auth.mode === 'token' → subscription
 *    d. providers.anthropic.authToken → subscription
 *    e. providers.anthropic.apiKey → apikey
 * 3. Default → apikey (conservative — proxy works fine)
 */
export function getOpenClawAuthMode() {
  // Env var is the strongest signal
  if (process.env.ANTHROPIC_AUTH_TOKEN) return 'subscription';
  if (process.env.ANTHROPIC_API_KEY) return 'apikey';

  // Try reading openclaw.json
  const home = homedir();
  const candidates = [
    join(home, '.openclaw', 'openclaw.json'),
    join(home, 'openclaw.json'),
  ];

  for (const configPath of candidates) {
    if (!existsSync(configPath)) continue;

    try {
      const raw = readFileSync(configPath, 'utf-8');
      const config = JSON.parse(stripJson5(raw));

      // Check explicit auth type
      if (config.auth?.type === 'oauth' || config.auth?.type === 'subscription') {
        return 'subscription';
      }

      // Check auth profiles (real OC config: auth.profiles["anthropic:default"].mode)
      const profiles = config.auth?.profiles;
      if (profiles && typeof profiles === 'object') {
        for (const profile of Object.values(profiles)) {
          if (profile?.mode === 'token') return 'subscription';
        }
      }

      // Check gateway auth mode
      if (config.gateway?.auth?.mode === 'token') return 'subscription';

      // Check for authToken in providers
      const anthropic = config.models?.providers?.anthropic
        || config.providers?.anthropic;
      if (anthropic?.authToken) return 'subscription';
      if (anthropic?.apiKey) return 'apikey';
    } catch {
      // Config unreadable — fall through
    }
  }

  return 'apikey';
}

/**
 * Detect if the environment is headless (no browser available).
 * On headless servers, login() tries xdg-open which fails silently,
 * then hangs for 120s waiting for a callback that never comes.
 */
export function isHeadless() {
  // SSH session — no local browser
  if (process.env.SSH_CONNECTION || process.env.SSH_CLIENT) return true;
  // Linux without a display server
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return true;
  // Docker / container
  if (process.env.container || process.env.DOCKER_CONTAINER) return true;
  return false;
}

/**
 * Check if Claude Code is installed.
 * Looks for ~/.claude/ directory which Claude Code creates on first run.
 */
export function isClaudeCodeInstalled() {
  return existsSync(join(homedir(), '.claude'));
}

/**
 * Check if Cursor is installed.
 * Looks for ~/.cursor/ directory which Cursor creates on first run.
 */
export function isCursorInstalled() {
  return existsSync(join(homedir(), '.cursor'));
}
