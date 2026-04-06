/**
 * Local JSONL event buffer for offline-resilient telemetry.
 *
 * Events are appended to a local JSONL file and periodically synced
 * to the platform API. Mirrors the Python EventBuffer in router.
 */

import { appendFileSync, readFileSync, writeFileSync, mkdirSync, statSync, renameSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ANALYTICS_DIR = join(homedir(), '.robot-resources', 'analytics');
const EVENTS_FILE = join(ANALYTICS_DIR, 'scraper-events.jsonl');
const OFFSET_FILE = join(ANALYTICS_DIR, 'scraper-events.offset');

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_ROTATED = 3;

function ensureDir(): void {
  try {
    mkdirSync(ANALYTICS_DIR, { recursive: true });
  } catch {
    // already exists
  }
}

/** Append a single event to the local JSONL file. */
export function appendEvent(event: Record<string, unknown>): void {
  ensureDir();
  const line = JSON.stringify({ ...event, _ts: new Date().toISOString() }) + '\n';
  try {
    appendFileSync(EVENTS_FILE, line, 'utf-8');
  } catch {
    // Silent — hot path must never throw
  }
}

function readOffset(): number {
  try {
    return parseInt(readFileSync(OFFSET_FILE, 'utf-8').trim(), 10) || 0;
  } catch {
    return 0;
  }
}

function writeOffset(offset: number): void {
  try {
    writeFileSync(OFFSET_FILE, String(offset), 'utf-8');
  } catch {
    // Silent
  }
}

export interface FlushResult {
  events: Record<string, unknown>[];
  newOffset: number;
}

/** Read up to `batchSize` unsent events. Call markSynced() after successful POST. */
export function flushBuffer(batchSize = 100): FlushResult {
  const offset = readOffset();
  const events: Record<string, unknown>[] = [];

  try {
    const content = readFileSync(EVENTS_FILE, 'utf-8');
    const remaining = content.slice(offset);
    const lines = remaining.split('\n');
    let bytesRead = offset;

    for (const line of lines) {
      if (!line.trim()) {
        bytesRead += line.length + 1; // +1 for \n
        continue;
      }
      try {
        const ev = JSON.parse(line) as Record<string, unknown>;
        delete ev._ts; // strip internal timestamp
        events.push(ev);
        bytesRead += line.length + 1;
      } catch {
        bytesRead += line.length + 1; // skip corrupted
        continue;
      }
      if (events.length >= batchSize) break;
    }

    return { events, newOffset: bytesRead };
  } catch {
    return { events: [], newOffset: offset };
  }
}

/** Advance the sync offset after a successful POST. */
export function markSynced(newOffset: number): void {
  writeOffset(newOffset);
}

/** Rotate the events file if all events are synced and file is large. */
export function maybeRotate(): void {
  try {
    const size = statSync(EVENTS_FILE).size;
    const offset = readOffset();
    if (size < MAX_FILE_BYTES || offset < size) return;

    // Shift rotated files
    for (let i = MAX_ROTATED; i > 0; i--) {
      const src = `${EVENTS_FILE}.${i}`;
      const dst = `${EVENTS_FILE}.${i + 1}`;
      try {
        if (i === MAX_ROTATED) unlinkSync(src);
        else renameSync(src, dst);
      } catch {
        // file doesn't exist, skip
      }
    }

    renameSync(EVENTS_FILE, `${EVENTS_FILE}.1`);
    writeOffset(0);
  } catch {
    // Silent
  }
}

/** Approximate count of unsent events (for diagnostics). */
export function pendingCount(): number {
  try {
    const size = statSync(EVENTS_FILE).size;
    const offset = readOffset();
    return size > offset ? Math.max(1, Math.round((size - offset) / 200)) : 0;
  } catch {
    return 0;
  }
}
