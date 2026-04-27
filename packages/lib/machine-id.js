import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

/**
 * Reads or creates a persistent machine identifier.
 * Used for telemetry deduplication across sessions.
 *
 * @param {string} [configDir] - Directory to store .machine-id (defaults to ~/.robot-resources)
 * @returns {string} A UUID v4 machine identifier
 */
export function getOrCreateMachineId(configDir) {
  const dir = configDir ?? join(homedir(), '.robot-resources');
  const machineIdPath = join(dir, '.machine-id');

  try {
    const stored = readFileSync(machineIdPath, 'utf-8').trim();
    if (stored) return stored;
  } catch {
    // File doesn't exist or can't be read — fall through to generate
  }

  const machineId = randomUUID();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(machineIdPath, machineId, 'utf-8');
  } catch { /* non-fatal */ }

  return machineId;
}
