#!/usr/bin/env node

import { runWizard } from '../lib/wizard.js';

const args = process.argv.slice(2);
const explicitNonInteractive =
  args.includes('--non-interactive') || args.includes('--yes') || args.includes('-y');
const targetArg = args.find((a) => a.startsWith('--for='));
const target = targetArg ? targetArg.slice('--for='.length) : null;

// Treat piped/CI runs (no TTY on stdin OR stdout) as non-interactive so the
// wizard never blocks on a prompt that can't be answered. The interactive
// menu is only opened when both stdin and stdout are real terminals.
const hasTty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
const nonInteractive = explicitNonInteractive || !hasTty;

runWizard({ nonInteractive, target }).catch((err) => {
  console.error(`\n  ✗ Setup failed: ${err.message}\n`);
  process.exit(1);
});
