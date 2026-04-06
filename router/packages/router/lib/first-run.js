/**
 * First-run silent provisioning for rr-router.
 *
 * On first run (no api_key in config), creates an API key via the
 * platform API using a stable machine ID. No prompts, no browser.
 *
 * Extracted from bin/rr-router.js for testability (TKT-057).
 */

import { readConfig, writeConfig } from "@robot-resources/cli-core/config.mjs";

/**
 * Silently provision an API key on first run.
 *
 * @param {object} [deps] - Injectable dependencies for testing.
 * @param {Function} [deps.readConfigFn] - Override readConfig.
 * @param {Function} [deps.writeConfigFn] - Override writeConfig.
 * @param {Function} [deps.fetchFn] - Override global fetch.
 * @returns {Promise<{provisioned: boolean, claim_url?: string}>}
 */
export async function firstRunSetup(deps = {}) {
  const readCfg = deps.readConfigFn || readConfig;
  const writeCfg = deps.writeConfigFn || writeConfig;
  const doFetch = deps.fetchFn || globalThis.fetch;

  const config = readCfg();
  if (config.api_key) {
    return { provisioned: false };
  }

  try {
    const { hostname, homedir } = await import("node:os");
    const { join } = await import("node:path");
    const { readFileSync, writeFileSync, mkdirSync } = await import("node:fs");
    const { randomUUID } = await import("node:crypto");

    const rrDir = join(homedir(), ".robot-resources");
    const machineIdPath = join(rrDir, ".machine-id");
    let machineId;
    try {
      machineId = readFileSync(machineIdPath, "utf-8").trim();
    } catch {
      machineId = randomUUID();
      try {
        mkdirSync(rrDir, { recursive: true });
        writeFileSync(machineIdPath, machineId, "utf-8");
      } catch { /* non-fatal */ }
    }

    const platformUrl = process.env.RR_PLATFORM_URL || "https://api.robotresources.ai";
    const res = await doFetch(`${platformUrl}/v1/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_name: hostname(),
        platform: "cli-router",
        machine_id: machineId,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (res.ok) {
      const { data } = await res.json();
      writeCfg({
        api_key: data.api_key,
        key_id: data.key_id,
        claim_url: data.claim_url,
        signup_source: "auto",
      });
      return { provisioned: true, claim_url: data.claim_url };
    }
  } catch {
    // Non-fatal — router works without telemetry
  }

  return { provisioned: false };
}
