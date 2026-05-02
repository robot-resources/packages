#!/usr/bin/env node

/**
 * Standalone setup CLI for `npx @robot-resources/router`.
 *
 * The router package has been npm-installable on its own since Phase 1
 * (the OC plugin path). Phase 5 adds this bin so `npx @robot-resources/router`
 * runs the same wizard as `npx robot-resources` BUT with `scope=router-only`
 * — skipping the scraper installation step.
 *
 * Implementation: shell out to the unified `robot-resources` CLI with the
 * scope flag. Lets us reuse all the existing wizard logic (provisioning,
 * detection, shell-config writing, pip install) without duplicating
 * any of it. Slightly slower first run (npx fetches the unified package
 * the first time), but the cache is shared with any later
 * `npx robot-resources` runs and it's a one-time cost.
 *
 * Why not import from `robot-resources`? The dependency arrow is
 * `robot-resources` → `@robot-resources/router`. Reversing it would be
 * circular. Spawning is the cleanest cross-workspace boundary.
 */

import { spawn } from 'node:child_process';

const userArgs = process.argv.slice(2);

// Pass-through args except --scope (which we always set). Users invoking
// the standalone bin shouldn't be able to flip back to the full scope.
const passthrough = userArgs.filter((a) => !a.startsWith('--scope='));

// Important: our package's bin is named `robot-resources-setup`, NOT
// `robot-resources` — there's a different `robot-resources` package on npm
// (a GitHub auth tool) that npx would resolve to without the explicit `-p`.
// Pin via `-p` (package source) + bin name for unambiguous resolution.
const args = ['--yes', '-p', 'robot-resources', 'robot-resources-setup', '--scope=router-only', ...passthrough];

const child = spawn('npx', args, {
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});

child.on('error', (err) => {
  console.error(`\n  ✗ Failed to launch wizard: ${err.message}\n`);
  console.error('  You can run the wizard directly:  npx robot-resources --scope=router-only\n');
  process.exit(1);
});
