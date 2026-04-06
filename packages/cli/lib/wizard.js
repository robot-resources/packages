import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, hostname } from 'node:os';
import { readConfig, writeConfig } from '@robot-resources/cli-core/config.mjs';
import { findPython, isPortAvailable, isHeadless, isOpenClawInstalled } from './detect.js';
import { getOrCreateMachineId } from './machine-id.js';
import { setupRouter, isRouterInstalled, getVenvPythonPath } from './python-bridge.js';
import { installService, isServiceRunning, isServiceInstalled } from './service.js';
import { configureToolRouting, registerScraperMcp, restartOpenClawGateway } from './tool-config.js';
import { checkHealth } from './health-report.js';
import { header, step, success, warn, error, info, blank, summary } from './ui.js';
/**
 * Main setup wizard. Handles the full onboarding flow:
 * 1. Router installation (Python venv + pip)
 * 2. Service registration (launchd/systemd)
 * 3. Tool routing (OpenClaw plugin + model activation)
 * 4. Dashboard link
 *
 * Auth is intentionally LAST. The router works fully without it.
 * Dashboard is for humans — agents don't need it.
 */
export async function runWizard({ nonInteractive = false } = {}) {
  header();

  const results = {
    auth: false,
    authMethod: null, // 'config' | 'apikey' | 'github'
    router: false,
    routerError: null,
    providerKeys: false,
    service: false,
  };

  // ── Step 0: Provision API key (before anything else) ────────────────────
  //
  // Provision early so config.json exists before any tool installs.
  // If the session dies later, telemetry still works for all tools.
  // Single fetch() with 10s timeout — no prompts, no browser.

  {
    const config = readConfig();
    if (!config.api_key && !process.env.RR_API_KEY) {
      try {
        const machineId = getOrCreateMachineId();

        const platformUrl = process.env.RR_PLATFORM_URL || 'https://api.robotresources.ai';
        const res = await fetch(`${platformUrl}/v1/auth/signup`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agent_name: hostname(),
            platform: 'cli',
            machine_id: machineId,
          }),
          signal: AbortSignal.timeout(10_000),
        });

        if (res.ok) {
          const { data } = await res.json();
          writeConfig({
            api_key: data.api_key,
            key_id: data.key_id,
            claim_url: data.claim_url,
            signup_source: 'auto',
          });
          results.auth = true;
          results.authMethod = 'auto';
          results.claimUrl = data.claim_url;
        }
      } catch {
        // Non-fatal — tools work without telemetry
      }
    } else {
      results.auth = true;
      results.authMethod = config.api_key ? 'config' : 'apikey';
      results.claimUrl = config.claim_url || null;
    }
  }

  // ── Step 1: Router Installation ─────────────────────────────────────────

  step('Checking Router...');

  if (isRouterInstalled()) {
    success('Router already installed');
    results.router = true;
  } else {
    const python = findPython();
    if (!python) {
      warn('Python 3.10+ not found — skipping Router installation');
      info('Install Python from https://python.org and re-run this wizard');
      info('Scraper works without Python');
    } else {
      info(`Found Python ${python.version} (${python.bin})`);
      step('Installing Router (this may take a moment)...');

      try {
        await setupRouter();
        success('Router installed');
        results.router = true;
      } catch (err) {
        error(`Router installation failed: ${err.message}`);
        results.routerError = 'install-failed';
      }
    }
  }

  // ── Step 1.5: Transparent Proxy Info ────────────────────────────────────

  if (results.router) {
    blank();
    step('Router proxy mode...');
    info('The Router works as a transparent proxy — no API keys needed.');
    info('Your AI tools already have their keys configured.');
    info('The Router reads them from each request and forwards automatically.');
  }

  // ── Step 2: Service Registration ────────────────────────────────────────

  if (results.router) {
    blank();
    step('Configuring Router as system service...');

    if (isServiceRunning()) {
      success('Router service already running');
      results.service = true;
    } else if (process.platform === 'win32') {
      warn('Windows detected — automatic service not supported');
      info('Run the router manually: rr-router start');
    } else {
      // Check port availability
      if (!isPortAvailable()) {
        warn('Port 3838 is already in use');
        info('Another process may be using this port. The service will retry on restart.');
      }

      try {
        const svc = installService(getVenvPythonPath());
        if (svc.type === 'skipped') {
          warn(svc.reason);
          results.service = false;
        } else {
          success(`Router registered as ${svc.type} service`);
          info(`Config: ${svc.path}`);
          info('Router will start automatically and restart on crash');
          results.service = true;
        }
      } catch (err) {
        error(`Service registration failed: ${err.message}`);
        info('You can start the router manually: rr-router start');
      }
    }
  }

  // ── Step 3: Tool Routing Configuration ──────────────────────────────────

  if (results.router) {
    blank();
    step('Configuring AI tools to use Router...');

    const toolResults = configureToolRouting();
    results.tools = toolResults;

    if (toolResults.length === 0) {
      info('No supported AI tools detected');
      info('Point your tool at http://localhost:3838 to enable cost optimization');
    } else {
      for (const r of toolResults) {
        if (r.action === 'configured') {
          success(`${r.name}: routing through localhost:3838`);
        } else if (r.action === 'already_configured') {
          success(`${r.name}: already configured`);
        } else if (r.action === 'installed') {
          success(`${r.name}: plugin installed`);
          if (r.configActivated) success(`${r.name}: plugin trusted in openclaw.json`);
          if (r.note) info(`  ${r.note}`);
        } else if (r.action === 'instructions') {
          warn(`${r.name}: manual configuration needed:`);
          for (const instruction of r.instructions) {
            info(`  ${instruction}`);
          }
        } else if (r.action === 'error') {
          error(`${r.name}: ${r.reason}`);
        }
      }
    }
  }

  // ── Step 4: Scraper Installation ───────────────────────────────────────
  //
  // Independent of router. Scraper works even if router failed to install.
  // Register scraper MCP in openclaw.json (if OC is present).
  // Gateway restart happens once at the very end (merged with plugin restart).

  blank();
  step('Installing Scraper...');

  results.scraper = false;
  let scraperRegistered = false;

  // Register MCP in openclaw.json
  scraperRegistered = registerScraperMcp();
  if (scraperRegistered) {
    success('Scraper MCP registered in OpenClaw — scraper_compress_url(url) available');
    results.scraper = true;
  } else {
    // Either already registered, or no openclaw.json
    try {
      const ocConfig = JSON.parse(readFileSync(join(homedir(), '.openclaw', 'openclaw.json'), 'utf-8'));
      if (ocConfig?.mcp?.servers?.['robot-resources-scraper']) {
        success('Scraper MCP already registered in OpenClaw');
        results.scraper = true;
      }
    } catch {
      // No openclaw.json — not on OC, skip
    }
  }

  // ── Step 4.5: Router Healthcheck ──────────────────────────────────────

  // Router: verify it's responding on localhost:3838
  if (results.service) {
    blank();
    step('Verifying Router is responding...');

    let healthy = false;
    // Retry a few times — the service may need a moment to start
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch('http://127.0.0.1:3838/health', {
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) {
          const data = await res.json();
          if (data.status === 'healthy' || data.status === 'degraded') {
            success(`Router healthy (v${data.version || 'unknown'})`);
            healthy = true;
            break;
          }
        }
      } catch {
        // Wait before retrying
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    if (!healthy) {
      warn('Router not responding yet — it may need a few more seconds to start');
      info('Check manually: curl http://localhost:3838/health');
    }
  }

  // ── Install Complete Telemetry ───────────────────────────────────────────
  //
  // Fire once after install, using the API key directly (not from config read-back).
  // This immediately populates last_used_at and proves the key works end-to-end.

  if (results.auth) {
    try {
      const config = readConfig();
      const platformUrl = process.env.RR_PLATFORM_URL || 'https://api.robotresources.ai';
      await fetch(`${platformUrl}/v1/telemetry`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.api_key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          product: 'cli',
          event_type: 'install_complete',
          payload: {
            router: results.router || false,
            service: results.service || false,
            scraper: results.scraper || false,
            source: 'wizard',
          },
        }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      // Non-fatal — install_complete is best-effort
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────

  const somethingInstalled = results.router || results.service || results.scraper;

  const lines = [];

  if (results.router && results.service) {
    lines.push('✓ Router running as transparent proxy (localhost:3838)');
    lines.push('  No API keys needed — reads them from your tools automatically');
  } else if (results.router) {
    lines.push('✓ Router installed (start manually: rr-router start)');
  } else if (results.routerError === 'install-failed') {
    lines.push('○ Router install failed (pip package not yet available — coming soon)');
  } else {
    lines.push('○ Router not installed (Python 3.10+ required)');
  }

  if (results.scraper) {
    lines.push('✓ Scraper MCP ready — use scraper_compress_url(url) to compress web content');
  } else {
    lines.push('○ Scraper MCP not configured');
  }

  summary(lines);

  // ── Dashboard link (provisioning already happened at Step 1.5) ──────────

  if (somethingInstalled) {
    blank();
    const claimUrl = results.claimUrl || readConfig().claim_url;
    success('Dashboard ready!');
    info('  https://robotresources.ai/dashboard');
    if (claimUrl) {
      info(`  Claim link (share with your human): ${claimUrl}`);
    }
  }

  // ── Human notification (agent/non-interactive installs) ─────────────────

  if (somethingInstalled && nonInteractive) {
    blank();
    warn('IMPORTANT: Notify your human about this installation.');
    info('Robot Resources has made the following changes to this machine:');
    if (results.router)  info('  • Router installed in ~/.robot-resources/');
    if (results.service) info('  • Router registered as a transparent proxy (localhost:3838)');
    if (results.service) info('  • Reads API keys from requests — no keys stored by Router');
    if (results.scraper) info('  • Scraper MCP configured — scraper_compress_url(url) available');
    blank();
    const claimLink = results.claimUrl || 'https://robotresources.ai/dashboard';
    info('Suggested message to your human (COPY THIS EXACTLY):');
    info('"I installed Robot Resources Router. It saves 60-90% on LLM costs.');
    info(' All calls now route through localhost:3838 for cost optimization.');
    info(` Claim your dashboard: ${claimLink}`);
    info(' More info: https://robotresources.ai"');
    blank();
  }

  // ── Post-install health check ──────────────────────────────────────────

  let healthReport = null;
  if (somethingInstalled) {
    try {
      blank();
      step('Running post-install health check...');
      healthReport = await checkHealth();

      if (healthReport.status === 'healthy') {
        success(`Health: all components healthy`);
      } else if (healthReport.status === 'partial') {
        warn(`Health: ${healthReport.summary}`);
      } else {
        error(`Health: ${healthReport.summary}`);
      }
    } catch {
      // Non-fatal — health check is informational
    }
  }

  // ── Status file (persists results for agents that lose the session) ─────

  if (somethingInstalled) {
    try {
      const statusDir = join(homedir(), '.robot-resources');
      mkdirSync(statusDir, { recursive: true });
      const pkgVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')).version;
      writeFileSync(join(statusDir, 'wizard-status.json'), JSON.stringify({
        completed_at: new Date().toISOString(),
        version: pkgVersion,
        router: results.router || false,
        service: results.service || false,
        scraper: results.scraper || false,
        plugin: results.tools?.some(r => r.action === 'installed') || false,
        claim_url: results.claimUrl || readConfig().claim_url || null,
        health_report: healthReport || null,
      }, null, 2) + '\n', { mode: 0o600, encoding: 'utf-8' });
    } catch {
      // Non-fatal — status file is a convenience, not required
    }
  }

  // ── Best-effort: Single gateway restart (MUST be last) ─────────────────
  //
  // Everything is already installed, configured, and reported above.
  // The restart loads the plugin + scraper MCP into the running gateway.
  // Telegram survives this restart. If the session dies here, the agent
  // picks up on the next message with all tools loaded.

  if (isOpenClawInstalled() && (results.tools?.some(r => r.action === 'installed') || scraperRegistered)) {
    try {
      await restartOpenClawGateway();
      success('OpenClaw gateway restarted');
    } catch {
      // Best-effort — gateway picks up changes on next restart
    }
  }
}
