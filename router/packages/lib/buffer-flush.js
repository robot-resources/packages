/**
 * Flush pending router telemetry events from the local JSONL buffer.
 *
 * The Python router buffers telemetry to ~/.robot-resources/analytics/router-events.jsonl
 * when the direct POST to the platform fails. If the router process dies before the
 * background sync drains the buffer, events sit on disk. This module reads those
 * events and ships them to the platform on plugin load — guaranteeing delivery even
 * when the router process is transient.
 *
 * Follows the same defensive patterns as update-check.js:
 *   - Top-level try/catch — never throws up
 *   - Early returns on missing preconditions
 *   - Fire-and-forget from register()
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_PLATFORM_URL = 'https://api.robotresources.ai';
const BATCH_SIZE = 100;
const POST_TIMEOUT_MS = 10_000;

function analyticsDir() {
  return join(homedir(), '.robot-resources', 'analytics');
}

function eventsPath() {
  return join(analyticsDir(), 'router-events.jsonl');
}

function offsetPath() {
  return join(analyticsDir(), 'router-events.offset');
}

function readOffset() {
  try {
    const raw = readFileSync(offsetPath(), 'utf-8').trim();
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writeOffset(bytePos) {
  const tmp = offsetPath() + '.tmp';
  try {
    writeFileSync(tmp, String(bytePos), 'utf-8');
    renameSync(tmp, offsetPath());
  } catch { /* best-effort */ }
}

/**
 * Read up to `limit` unsent events from the JSONL buffer starting at `offset`.
 * Returns { events, newOffset } where newOffset is the byte position after
 * the last parsed line.
 */
function readEvents(offset, limit = BATCH_SIZE) {
  const fp = eventsPath();
  if (!existsSync(fp)) return { events: [], newOffset: offset };

  let raw;
  try {
    raw = readFileSync(fp, 'utf-8');
  } catch {
    return { events: [], newOffset: offset };
  }

  // Nothing new
  if (offset >= raw.length) return { events: [], newOffset: offset };

  const tail = raw.slice(offset);
  const lines = tail.split('\n');
  const events = [];
  let consumed = 0;

  for (const line of lines) {
    // +1 accounts for the \n delimiter
    consumed += Buffer.byteLength(line, 'utf-8') + 1;
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const ev = JSON.parse(trimmed);
      delete ev._ts; // strip internal timestamp (matches Python buffer.flush)
      events.push(ev);
    } catch {
      continue; // skip corrupted lines
    }
    if (events.length >= limit) break;
  }

  // Subtract the trailing +1 if the file doesn't end with \n
  const newOffset = offset + consumed - (tail.endsWith('\n') ? 0 : 1);

  return { events, newOffset: Math.min(newOffset, raw.length) };
}

/**
 * POST a batch of events to the platform. Returns true on 2xx.
 */
async function postBatch(events, { platformUrl, apiKey }) {
  const url = `${platformUrl}/v1/telemetry`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ events }),
    signal: AbortSignal.timeout(POST_TIMEOUT_MS),
  });
  return resp.status < 300;
}

/**
 * Flush all pending router telemetry events. Safe to call fire-and-forget.
 *
 * @param {object} opts
 * @param {string} [opts.platformUrl] — override platform URL
 * @param {string} [opts.apiKey] — Robot Resources API key
 * @param {object} [opts.logger] — OpenClaw logger
 * @param {object} [opts.telemetry] — plugin telemetry client (for meta-events)
 */
export async function runBufferFlush({ platformUrl, apiKey, logger, telemetry } = {}) {
  try {
    await runBufferFlushInner({ platformUrl, apiKey, logger, telemetry });
  } catch (err) {
    try {
      logger?.warn?.(`[robot-resources] buffer-flush failed: ${err?.message || err}`);
    } catch { /* swallow */ }
  }
}

async function runBufferFlushInner({ platformUrl, apiKey, logger, telemetry }) {
  if (!apiKey) return;

  const url = (platformUrl || DEFAULT_PLATFORM_URL).replace(/\/+$/, '');
  let offset = readOffset();
  let totalFlushed = 0;

  // Drain the buffer in batches
  while (true) {  // eslint-disable-line no-constant-condition
    const { events, newOffset } = readEvents(offset);
    if (events.length === 0) break;

    let ok;
    try {
      ok = await postBatch(events, { platformUrl: url, apiKey });
    } catch {
      ok = false;
    }

    if (!ok) {
      telemetry?.emit('buffer_flush_failed', {
        pending_count: events.length,
        offset,
      });
      logger?.warn?.(`[robot-resources] buffer flush: POST failed, ${events.length} events pending`);
      return; // Stop — don't advance offset, retry next session
    }

    writeOffset(newOffset);
    offset = newOffset;
    totalFlushed += events.length;

    // If we got fewer than BATCH_SIZE, we've drained everything
    if (events.length < BATCH_SIZE) break;
  }

  if (totalFlushed > 0) {
    telemetry?.emit('buffer_flush_completed', { count: totalFlushed });
    logger?.info?.(`[robot-resources] buffer flush: shipped ${totalFlushed} buffered router event(s)`);
  }
}
