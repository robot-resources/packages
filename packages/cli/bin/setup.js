#!/usr/bin/env node

import { runWizard } from '../lib/wizard.js';

const args = process.argv.slice(2);
const nonInteractive = args.includes('--non-interactive') || args.includes('--yes') || args.includes('-y');

runWizard({ nonInteractive }).catch((err) => {
  console.error(`\n  ✗ Setup failed: ${err.message}\n`);
  process.exit(1);
});
