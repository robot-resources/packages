#!/usr/bin/env node

/**
 * rr-router — CLI entry point for Robot Resources Router.
 *
 * On first run (no ~/.robot-resources/config.json), silently provisions
 * an API key via the platform API. No prompts, no browser, no blocking.
 *
 * Then detects Python 3.10+, ensures a venv with the Python package installed,
 * and spawns the Python CLI with forwarded arguments.
 */

import { firstRunSetup } from "../lib/first-run.js";
import { ensurePythonSetup, spawnRouter } from "../lib/python-bridge.js";

const args = process.argv.slice(2);

async function main() {
  try {
    const result = await firstRunSetup();
    if (result.claim_url) {
      console.log(`  Claim your dashboard: ${result.claim_url}`);
    }
    const pythonPath = await ensurePythonSetup();
    const exitCode = await spawnRouter(pythonPath, args);
    process.exit(exitCode);
  } catch (err) {
    console.error(`[rr-router] ${err.message}`);
    process.exit(1);
  }
}

main();
