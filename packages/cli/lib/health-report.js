import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readConfig } from '@robot-resources/cli-core/config.mjs';

const PROBE_TIMEOUT_MS = 5_000;

/**
 * Run post-install health checks against all Robot Resources components.
 *
 * Probes:
 *  1. Router   — GET http://127.0.0.1:3838/health
 *  2. Scraper  — check openclaw.json for scraper MCP registration
 *  3. Platform — GET {platformUrl}/v1/health with api_key
 *  4. MCP      — check openclaw.json for openclaw-plugin registration
 *
 * @returns {{ status: 'healthy'|'partial'|'failed', components: Object, summary: string }}
 */
export async function checkHealth() {
  const config = readConfig();

  const [router, scraper, platform, mcp] = await Promise.all([
    probeRouter(),
    probeScraper(),
    probePlatform(config),
    probeMcp(),
  ]);

  const components = { router, scraper, platform, mcp };
  const healthyCount = Object.values(components).filter((c) => c.healthy).length;
  const total = Object.keys(components).length;

  let status;
  if (healthyCount === total) {
    status = 'healthy';
  } else if (healthyCount === 0) {
    status = 'failed';
  } else {
    status = 'partial';
  }

  const failing = Object.entries(components)
    .filter(([, c]) => !c.healthy)
    .map(([name, c]) => `${name}: ${c.detail}`);

  const summary =
    status === 'healthy'
      ? `All ${total} components healthy.`
      : `${healthyCount}/${total} healthy. Issues: ${failing.join('; ')}`;

  return { status, components, summary };
}

async function probeRouter() {
  try {
    if (typeof fetch === 'undefined') {
      return { healthy: false, detail: 'fetch unavailable' };
    }
    const res = await fetch('http://127.0.0.1:3838/health', {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { healthy: false, detail: `HTTP ${res.status}` };
    }
    const data = await res.json();
    if (data.status === 'healthy' || data.status === 'degraded') {
      return { healthy: true, detail: `running (v${data.version || 'unknown'})` };
    }
    return { healthy: false, detail: `status: ${data.status}` };
  } catch (err) {
    const detail = err.name === 'AbortError' ? 'timeout' : 'unreachable';
    return { healthy: false, detail };
  }
}

function probeScraper() {
  try {
    const ocPath = join(homedir(), '.openclaw', 'openclaw.json');
    const ocConfig = JSON.parse(readFileSync(ocPath, 'utf-8'));
    const hasServer = !!ocConfig?.mcp?.servers?.['robot-resources-scraper'];
    return {
      healthy: hasServer,
      detail: hasServer ? 'MCP registered' : 'scraper MCP not registered',
    };
  } catch {
    return { healthy: false, detail: 'openclaw.json not found' };
  }
}

async function probePlatform(config) {
  if (!config.api_key) {
    return { healthy: false, detail: 'no API key configured' };
  }
  try {
    if (typeof fetch === 'undefined') {
      return { healthy: false, detail: 'fetch unavailable' };
    }
    const platformUrl = process.env.RR_PLATFORM_URL || 'https://api.robotresources.ai';
    const res = await fetch(`${platformUrl}/health`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return {
      healthy: res.ok,
      detail: res.ok ? 'reachable' : `HTTP ${res.status}`,
    };
  } catch (err) {
    const detail = err.name === 'AbortError' ? 'timeout' : 'unreachable';
    return { healthy: false, detail };
  }
}

function probeMcp() {
  try {
    const ocPath = join(homedir(), '.openclaw', 'openclaw.json');
    const ocConfig = JSON.parse(readFileSync(ocPath, 'utf-8'));
    const hasPlugin = !!ocConfig?.plugins?.entries?.['openclaw-plugin']?.enabled;
    return {
      healthy: hasPlugin,
      detail: hasPlugin ? 'plugin registered' : 'openclaw-plugin not registered',
    };
  } catch {
    return { healthy: false, detail: 'openclaw.json not found' };
  }
}
