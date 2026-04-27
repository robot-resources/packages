/**
 * Platform telemetry reporter for scraper.
 *
 * Events are buffered locally in a JSONL file and synced to the
 * platform API periodically. Fire-and-forget — never blocks the
 * scrape() pipeline.
 */

import { pushDebugEntry } from './debug.js';
import { appendEvent } from './telemetry-buffer.js';
import { syncNow } from './telemetry-sync.js';

export interface ScraperTelemetryPayload {
  url: string;
  tokenCount: number;
  originalTokenCount?: number;
  title?: string;
  latencyMs: number;
  success: boolean;
  error?: string;
}

/**
 * Report a scrape() call by buffering it locally.
 *
 * Events are written to ~/.robot-resources/analytics/scraper-events.jsonl
 * and synced to the platform by the background sync task.
 * Returns undefined — the write is synchronous and local.
 */
export function reportScraperEvent(payload: ScraperTelemetryPayload): void {
  // Environment-level opt-out
  if (process.env.RR_TELEMETRY === 'off') return;

  const eventType = payload.success ? 'compress' : 'error';

  try {
    appendEvent({
      product: 'scraper',
      event_type: eventType,
      payload,
    });

    pushDebugEntry('scraper-telemetry', {
      event_type: eventType,
      url: payload.url,
      buffered: true,
    });
  } catch {
    pushDebugEntry('scraper-telemetry', {
      event_type: eventType,
      url: payload.url,
      buffered: false,
      error: 'buffer_write_failed',
    });
  }
}

/**
 * Flush buffered telemetry to the platform. Call before process exit
 * in short-lived contexts (MCP servers, CLI tools).
 */
export async function flushTelemetry(): Promise<void> {
  await syncNow();
}
