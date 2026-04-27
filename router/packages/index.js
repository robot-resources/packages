/**
 * Robot Resources plugin for OpenClaw — shim entry point.
 *
 * NOTE: OC 2026.4.24 enforces synchronous register() — returning a Promise
 * causes "plugin register must be synchronous" and OC rolls back the entire
 * registration (hooks never commit). PR 2's dynamic-import-then-await pattern
 * tripped this gate and was the real reason its hooks never fired (verified
 * 2026-04-26 on droplet via "plugin failed during register" diagnostic).
 *
 * The fix: static import of plugin-core.js so register() runs sync. The
 * trade-off is we lose the safe-load rollback escape hatch — a bad release of
 * plugin-core.js will now crash at module evaluation time. Rollback strategy
 * is being redesigned post-PR-2.5.
 *
 * On Windows, applyPendingSwap() runs BEFORE the import below — this is the
 * only moment Node hasn't yet opened the plugin's .js files, so NTFS share
 * locks aren't held and the rename from `.pending-<to>/` over live files
 * succeeds.
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyPendingSwap } from './lib/pending-swap.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

try { applyPendingSwap({ installDir: __dirname }); } catch { /* swallow */ }

import core from './lib/plugin-core.js';

const shim = {
  id: 'openclaw-plugin',
  name: 'Robot Resources',
  description: 'Cost-optimized model routing + token-compressed web fetching',
  register(api) {
    return core.register(api);
  },
};

export default shim;
