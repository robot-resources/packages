/**
 * Debug data output for Agent E2E Test Lab.
 *
 * When RR_DEBUG=1, writes JSON ring buffers to ~/.robot-resources/debug/.
 * Zero overhead when RR_DEBUG is not set — early return before any I/O.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEBUG_DIR = join(homedir(), '.robot-resources', 'debug');
const DEFAULT_RETAIN = 100;

const buffers = new Map<string, object[]>();

function getRetainLimit(): number {
  const env = process.env.RR_DEBUG_RETAIN;
  if (env !== undefined) {
    const n = parseInt(env, 10);
    return Number.isNaN(n) ? DEFAULT_RETAIN : Math.max(0, n);
  }
  return DEFAULT_RETAIN;
}

/**
 * Push a debug entry to a named ring buffer and flush to disk.
 *
 * @param file - Base filename without extension (e.g., 'scraper-compressions')
 * @param entry - Data object to record (timestamp added automatically)
 */
export function pushDebugEntry(file: string, entry: object): void {
  if (process.env.RR_DEBUG !== '1') return;

  const limit = getRetainLimit();
  let buffer = buffers.get(file);
  if (!buffer) {
    buffer = [];
    buffers.set(file, buffer);
  }

  buffer.push({ timestamp: new Date().toISOString(), ...entry });

  // Evict oldest entries beyond retain limit
  while (buffer.length > limit && limit > 0) {
    buffer.shift();
  }
  // If limit is 0, clear entirely
  if (limit === 0) {
    buffer.length = 0;
  }

  try {
    mkdirSync(DEBUG_DIR, { recursive: true });
    writeFileSync(join(DEBUG_DIR, `${file}.json`), JSON.stringify(buffer, null, 2));
  } catch {
    // Silent — debug must never break the pipeline
  }
}
