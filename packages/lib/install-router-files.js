import { existsSync, mkdirSync, copyFileSync, cpSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * Copy `@robot-resources/router` to ~/.robot-resources/router/ and return
 * the absolute path to its auto.cjs.
 *
 * Phase 8 fix. Mirrors `installPluginFiles()` in tool-config.js (the OC
 * plugin path that's worked since Phase 0). The destination is a stable
 * user-scoped location that survives npm/npx cache cleanups, so the
 * NODE_OPTIONS line we write to shell rc doesn't break when caches expire.
 *
 * Files copied: auto.cjs, index.js, package.json, lib/ (recursive).
 * Each call wipes lib/ first so files removed in newer router versions
 * don't linger from a previous install.
 *
 * Why this is its own module: extracted from install-node-shim.js for
 * testability — vitest can mock the whole module without us mocking
 * node:fs / node:module manually in every install-shim test case.
 */
export function installRouterFiles({ home = homedir() } = {}) {
  const pkgPath = require.resolve('@robot-resources/router/package.json');
  const pkgDir = dirname(pkgPath);
  const targetDir = join(home, '.robot-resources', 'router');
  mkdirSync(targetDir, { recursive: true });

  for (const file of ['auto.cjs', 'index.js', 'package.json']) {
    const src = join(pkgDir, file);
    if (existsSync(src)) {
      copyFileSync(src, join(targetDir, file));
    }
  }

  // Refresh lib/ — wipe + recopy so we don't accumulate stale files across
  // router upgrades. Same pattern as tool-config.js installPluginFiles().
  const srcLib = join(pkgDir, 'lib');
  const dstLib = join(targetDir, 'lib');
  if (existsSync(srcLib)) {
    rmSync(dstLib, { recursive: true, force: true });
    cpSync(srcLib, dstLib, { recursive: true });
  }

  return join(targetDir, 'auto.cjs');
}
