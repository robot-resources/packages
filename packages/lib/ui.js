import { createInterface } from 'node:readline';

// ANSI color helpers (no dependencies)
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  orange: '\x1b[38;5;208m',
};

export function header() {
  console.log(`\n  ${c.orange}${c.bold}██ Robot Resources — Setup${c.reset}\n`);
}

export function step(msg) {
  console.log(`  ${c.cyan}→${c.reset} ${msg}`);
}

export function success(msg) {
  console.log(`  ${c.green}✓${c.reset} ${msg}`);
}

export function warn(msg) {
  console.log(`  ${c.yellow}!${c.reset} ${msg}`);
}

export function error(msg) {
  console.log(`  ${c.red}✗${c.reset} ${msg}`);
}

export function info(msg) {
  console.log(`  ${c.dim}${msg}${c.reset}`);
}

export function blank() {
  console.log('');
}

export function summary(lines) {
  console.log(`\n  ${c.orange}${c.bold}── Summary ──${c.reset}\n`);
  for (const line of lines) {
    console.log(`  ${line}`);
  }
  console.log('');
}

/**
 * Prompt for free-text input (e.g. API keys).
 * Returns the trimmed answer, or empty string if skipped.
 * In non-interactive mode, returns the default value.
 */
export function prompt(question, { defaultValue = '', nonInteractive = false } = {}) {
  if (nonInteractive) return Promise.resolve(defaultValue);

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  return new Promise((resolve) => {
    rl.question(`  ${question}: `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Prompt for yes/no confirmation. Returns true for yes.
 * In non-interactive mode, returns the default value.
 */
export function confirm(question, { defaultYes = true, nonInteractive = false } = {}) {
  if (nonInteractive) return Promise.resolve(defaultYes);

  const hint = defaultYes ? 'Y/n' : 'y/N';
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  return new Promise((resolve) => {
    rl.question(`  ${question} (${hint}): `, (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      if (trimmed === '') resolve(defaultYes);
      else resolve(trimmed === 'y' || trimmed === 'yes');
    });
  });
}
