/**
 * Background telemetry sync for scraper.
 *
 * Periodically reads unsent events from the local JSONL buffer and
 * POSTs them in batches to the platform API. Designed for both
 * long-running processes (interval) and short-lived MCP servers (syncNow).
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { flushBuffer, markSynced, maybeRotate } from './telemetry-buffer.js';

const CONFIG_PATH = join(homedir(), '.robot-resources', 'config.json');
const DEFAULT_PLATFORM_URL = 'https://api.robotresources.ai';

const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const BATCH_SIZE = 100;

let intervalHandle: ReturnType<typeof setInterval> | null = null;

function loadConfig(): { apiKey: string | null; platformUrl: string } {
  if (process.env.RR_TELEMETRY === 'off') {
    return { apiKey: null, platformUrl: DEFAULT_PLATFORM_URL };
  }

  try {
    const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as Record<string, unknown>;
    if (config.telemetry === false) return { apiKey: null, platformUrl: DEFAULT_PLATFORM_URL };
    const url = (process.env.RR_PLATFORM_URL || config.platform_url || DEFAULT_PLATFORM_URL) as string;
    return { apiKey: (config.api_key as string) || null, platformUrl: url };
  } catch {
    return { apiKey: null, platformUrl: DEFAULT_PLATFORM_URL };
  }
}

/** POST a batch to /v1/telemetry. Returns true on success. */
async function postBatch(
  events: Record<string, unknown>[],
  apiKey: string,
  platformUrl: string,
): Promise<boolean> {
  try {
    const resp = await fetch(`${platformUrl}/v1/telemetry`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ events }),
    });
    return resp.status < 500; // 4xx = bad data, don't retry
  } catch {
    return false;
  }
}

/** Sync one batch of buffered events to the platform. */
export async function syncNow(): Promise<void> {
  const { apiKey, platformUrl } = loadConfig();
  if (!apiKey) return;

  const { events, newOffset } = flushBuffer(BATCH_SIZE);
  if (events.length === 0) {
    maybeRotate();
    return;
  }

  const ok = await postBatch(events, apiKey, platformUrl);
  if (ok) {
    markSynced(newOffset);
  }
}

/** Start a periodic sync interval. Call stopSyncInterval() on shutdown. */
export function startSyncInterval(): void {
  if (intervalHandle) return; // already running
  intervalHandle = setInterval(() => {
    syncNow().catch(() => {}); // errors handled inside syncNow
  }, SYNC_INTERVAL_MS);
  // Allow the process to exit even if the interval is running
  if (intervalHandle && typeof intervalHandle === 'object' && 'unref' in intervalHandle) {
    intervalHandle.unref();
  }
}

/** Stop the periodic sync interval. */
export function stopSyncInterval(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
