import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, hostname, release as osRelease } from 'node:os';
import { readConfig, writeConfig } from './config.mjs';
import { isOpenClawInstalled } from './detect.js';
import { getOrCreateMachineId } from './machine-id.js';
import { configureToolRouting, registerScraperMcp, restartOpenClawGateway } from './tool-config.js';
import { checkHealth } from './health-report.js';
import { header, step, success, warn, error, info, blank, summary } from './ui.js';
import { runNonOcWizard } from './non-oc-wizard.js';

// Stamped onto every CLI telemetry payload so we can tell which `robot-resources`
// version a user actually ran. Without this, npx-cached old installers look
// identical to fresh runs in Supabase — exactly the visibility gap that left
// us blind on real-user install failures despite shipping rich diagnostics
// in PR #163. Read once at module load; safe to fail (telemetry just lands
// without the field).
const CLI_VERSION = (() => {
  try {
    return JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
    ).version;
  } catch {
    return null;
  }
})();

/**
 * Main setup wizard. In Option 4 (post-PR-2.5) the wizard does NOT install
 * a Python daemon, register a system service, or run a localhost health
 * probe — the router lives entirely inside the OC plugin's process now.
 * The wizard's job is reduced to:
 *
 * 1. Provision an anonymous api_key (telemetry/dashboard identity).
 * 2. Install both OC plugins:
 *    a. router plugin (in-process HTTP server + routing logic) into
 *       ~/.openclaw/extensions/robot-resources-router/
 *    b. scraper OC plugin (web_fetch → scraper_compress_url hook) into
 *       ~/.openclaw/extensions/robot-resources-scraper-oc-plugin/
 * 3. Register the scraper MCP in openclaw.json.
 * 4. Restart the OC gateway so the plugins load.
 *
 * No Python, no venv, no systemd, no port probe.
 */
export async function runWizard({ nonInteractive = false, target = null } = {}) {
  header();

  // Detect OC once up front. Used both to branch into the non-OC wizard and
  // to tag the wizard_started payload, so the funnel can be segmented OC vs
  // non-OC without a second event type.
  const openclawDetected = isOpenClawInstalled();
  const wizardStartMs = Date.now();

  const results = {
    auth: false,
    authMethod: null, // 'config' | 'apikey' | 'auto'
    pluginInstalled: false,
    openclawDetected,
    openclawConfigPatched: false,
    scraperMcpRegistered: false,
    scraper: false,
  };

  // ── Step 0: Provision API key (before anything else) ────────────────────
  //
  // Runs for BOTH the OC and non-OC paths. Provisioning before the non-OC
  // hand-off closes the funnel blind spot where every non-OpenClaw install
  // was invisible to telemetry (no api_keys row, no wizard_started, no
  // agent_signup_meta). If the session dies later, telemetry still works
  // for all tools. Single fetch() with 10s timeout — no prompts, no browser.

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

  // ── Funnel marker: wizard_started ───────────────────────────────────────
  //
  // Sent immediately after auth, before either path branches, so we have
  // proof the wizard reached this point even if a later step crashes. Pairs
  // with install_complete (OC path) or wizard_path_chosen (non-OC path) to
  // give us a "started → done" funnel. The openclaw_detected field lets us
  // segment OC vs non-OC funnels without a second event type.
  //
  // Timeout asymmetry vs install_complete (5s, no retry vs 10s × 2 attempts):
  // wizard_started is a best-effort funnel marker — losing it just means we
  // miss one funnel datapoint. install_complete is a heartbeat that powers
  // last_used_at and the "wizard ran successfully" signal, so it gets the
  // longer timeout + retry to maximize delivery.

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
          event_type: 'wizard_started',
          payload: {
            cli_version: CLI_VERSION,
            auth_method: results.authMethod,
            non_interactive: nonInteractive,
            openclaw_detected: openclawDetected,
          },
        }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      // Non-fatal — wizard_started is best-effort
    }
  }

  // Non-OC branch. Hands off to the multi-agent compatibility wizard which
  // routes the user to the right install path (npm install / pip install /
  // MCP config / docs / install-OC). The non-OC wizard's wizard_path_chosen
  // telemetry now fires too, since Step 0 above provisioned an api_key.
  if (!openclawDetected) {
    await runNonOcWizard({ nonInteractive, target });
    return;
  }

  // ── Step 1: Tool Routing Configuration ──────────────────────────────────
  //
  // Installs the OC plugin (which is @robot-resources/router — the router
  // IS the OC plugin in the in-process architecture). The plugin's
  // register() starts an in-process HTTP server on 127.0.0.1:18790 that
  // OC dispatches LLM calls to. No daemon to spawn, no service to register.

  blank();
  step('Configuring AI tools to use Router...');

  const toolResults = configureToolRouting();
  results.tools = toolResults;

  const ocResult = toolResults.find((r) => r.name === 'OpenClaw');
  if (ocResult) {
    results.pluginInstalled =
      ocResult.action === 'installed' || ocResult.action === 'already_configured';
    results.openclawConfigPatched = Boolean(ocResult.configActivated);
  }

  if (toolResults.length === 0) {
    info('No supported AI tools detected');
    info('Install OpenClaw and re-run: npx robot-resources');
  } else {
    for (const r of toolResults) {
      if (r.action === 'configured') {
        success(`${r.name}: routing configured`);
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

  // ── Step 2: Scraper Installation ───────────────────────────────────────
  //
  // Independent of router. Register scraper MCP in openclaw.json (if OC
  // is present). Gateway restart happens once at the very end (merged
  // with plugin restart).

  blank();
  step('Installing Scraper...');

  let scraperRegistered = false;

  scraperRegistered = registerScraperMcp();
  if (scraperRegistered) {
    success('Scraper MCP registered in OpenClaw — scraper_compress_url(url) available');
    results.scraper = true;
    results.scraperMcpRegistered = true;
  } else {
    try {
      const ocConfig = JSON.parse(readFileSync(join(homedir(), '.openclaw', 'openclaw.json'), 'utf-8'));
      if (ocConfig?.mcp?.servers?.['robot-resources-scraper']) {
        success('Scraper MCP already registered in OpenClaw');
        results.scraper = true;
        results.scraperMcpRegistered = true;
      }
    } catch {
      // No openclaw.json — not on OC, skip
    }
  }

  // ── Install Complete Telemetry ───────────────────────────────────────────
  //
  // Fire once after install, using the API key directly (not from config read-back).
  // This immediately populates last_used_at and proves the key works end-to-end.
  //
  // Retry once with longer timeout — Cloudflare analytics showed client-side
  // aborts on the original 5s single-attempt, leaving stranded signups with
  // no telemetry. Two 10s attempts catch the long tail. Still fire-and-forget.

  if (results.auth) {
    try {
      const config = readConfig();
      const platformUrl = process.env.RR_PLATFORM_URL || 'https://api.robotresources.ai';
      const installPayload = {
        source: 'wizard',
        cli_version: CLI_VERSION,
        plugin_installed: results.pluginInstalled,
        scraper: results.scraper || false,
        platform: process.platform,
        os_release: osRelease(),
        node_version: process.version,
        install_duration_ms: Date.now() - wizardStartMs,
        openclaw_detected: results.openclawDetected,
        openclaw_config_patched: results.openclawConfigPatched,
        scraper_mcp_registered: results.scraperMcpRegistered,
      };
      const body = JSON.stringify({
        product: 'cli',
        event_type: 'install_complete',
        payload: installPayload,
      });

      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await fetch(`${platformUrl}/v1/telemetry`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${config.api_key}`,
              'Content-Type': 'application/json',
            },
            body,
            signal: AbortSignal.timeout(10_000),
          });
          if (res.ok) break;
        } catch {
          // Try again on next iteration; outer catch handles total failure
        }
      }
    } catch {
      // Non-fatal — install_complete is best-effort
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────

  const somethingInstalled = results.pluginInstalled || results.scraper;

  const lines = [];

  if (results.pluginInstalled) {
    lines.push('✓ Router plugin installed — in-process routing active inside OpenClaw');
    lines.push('  No daemon to manage. Plugin starts and stops with OC.');
  } else if (!results.openclawDetected) {
    lines.push('○ OpenClaw not detected — install OC, then re-run npx robot-resources');
  } else {
    lines.push('○ Router plugin install failed — see errors above');
  }

  if (results.scraper) {
    lines.push('✓ Scraper MCP ready — use scraper_compress_url(url) to compress web content');
  } else if (results.openclawDetected) {
    lines.push('○ Scraper MCP not configured');
  }

  summary(lines);

  // ── Dashboard link (provisioning already happened at Step 0) ────────────

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

  if (somethingInstalled && nonInteractive && !process.env.RR_API_KEY) {
    blank();
    warn('IMPORTANT: Notify your human about this installation.');
    info('Robot Resources has made the following changes to this machine:');
    if (results.pluginInstalled) {
      info('  • Router plugin installed in ~/.openclaw/extensions/robot-resources-router/');
      info('  • Scraper plugin installed in ~/.openclaw/extensions/robot-resources-scraper-oc-plugin/');
    }
    if (results.pluginInstalled) info('  • Plugin runs in-process inside OpenClaw — no separate service');
    if (results.scraper) info('  • Scraper MCP configured — scraper_compress_url(url) available');
    blank();
    const claimLink = results.claimUrl || 'https://robotresources.ai/dashboard';
    info('Suggested message to your human (COPY THIS EXACTLY):');
    info('"I installed Robot Resources Router. It saves 60-90% on LLM costs');
    info(' by smart-selecting the cheapest Anthropic model for each prompt.');
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
        success('Health: all components healthy');
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
      writeFileSync(join(statusDir, 'wizard-status.json'), JSON.stringify({
        completed_at: new Date().toISOString(),
        version: CLI_VERSION,
        plugin: results.pluginInstalled,
        scraper: results.scraper || false,
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

  if (openclawDetected && (results.tools?.some(r => r.action === 'installed') || scraperRegistered)) {
    try {
      await restartOpenClawGateway();
      success('OpenClaw gateway restarted');
    } catch {
      // Best-effort — gateway picks up changes on next restart
    }
  }
}
