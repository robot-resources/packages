import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock node:fs — used by telemetry-buffer.ts for local JSONL writes
const { mockAppendFileSync, mockReadFileSync, mockWriteFileSync, mockMkdirSync, mockStatSync } = vi.hoisted(() => ({
  mockAppendFileSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockStatSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  appendFileSync: mockAppendFileSync,
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  mkdirSync: mockMkdirSync,
  statSync: mockStatSync,
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

import type { ScraperTelemetryPayload } from '../telemetry.js';

const basePayload: ScraperTelemetryPayload = {
  url: 'https://example.com',
  tokenCount: 500,
  title: 'Example',
  latencyMs: 120,
  success: true,
};

describe('reportScraperEvent', () => {
  beforeEach(async () => {
    mockAppendFileSync.mockReset();
    mockReadFileSync.mockReset();
    mockWriteFileSync.mockReset();
    mockMkdirSync.mockReset();
    mockStatSync.mockReset();
    vi.resetModules();
    // Re-stub fetch for syncNow/flushTelemetry
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response('ok', { status: 200 }))
    );
  });

  describe('local buffer behavior', () => {
    it('returns void (synchronous local write)', async () => {
      const { reportScraperEvent: report } = await import('../telemetry.js');
      const result = report(basePayload);
      expect(result).toBeUndefined();
    });

    it('calls appendFileSync to write event to JSONL', async () => {
      const { reportScraperEvent: report } = await import('../telemetry.js');
      report(basePayload);

      expect(mockAppendFileSync).toHaveBeenCalledOnce();
      const [, content] = mockAppendFileSync.mock.calls[0];
      const parsed = JSON.parse(content.replace('\n', ''));
      expect(parsed.product).toBe('scraper');
      expect(parsed.event_type).toBe('compress');
      expect(parsed.payload).toEqual(expect.objectContaining({
        url: 'https://example.com',
        success: true,
      }));
    });

    it('sends event_type "compress" when success is true', async () => {
      const { reportScraperEvent: report } = await import('../telemetry.js');
      report({ ...basePayload, success: true });

      const [, content] = mockAppendFileSync.mock.calls[0];
      const parsed = JSON.parse(content.replace('\n', ''));
      expect(parsed.event_type).toBe('compress');
    });

    it('sends event_type "error" when success is false', async () => {
      const { reportScraperEvent: report } = await import('../telemetry.js');
      report({ ...basePayload, success: false, error: 'Timeout' });

      const [, content] = mockAppendFileSync.mock.calls[0];
      const parsed = JSON.parse(content.replace('\n', ''));
      expect(parsed.event_type).toBe('error');
      expect(parsed.payload.error).toBe('Timeout');
    });
  });

  describe('telemetry opt-out', () => {
    it('does not write when RR_TELEMETRY=off', async () => {
      vi.stubEnv('RR_TELEMETRY', 'off');
      const { reportScraperEvent: report } = await import('../telemetry.js');
      report(basePayload);

      expect(mockAppendFileSync).not.toHaveBeenCalled();
      vi.unstubAllEnvs();
    });

    it('writes normally when RR_TELEMETRY is not "off"', async () => {
      vi.stubEnv('RR_TELEMETRY', 'on');
      const { reportScraperEvent: report } = await import('../telemetry.js');
      report(basePayload);

      expect(mockAppendFileSync).toHaveBeenCalledOnce();
      vi.unstubAllEnvs();
    });
  });

  describe('error resilience', () => {
    it('silently catches appendFileSync errors', async () => {
      mockAppendFileSync.mockImplementation(() => {
        throw new Error('ENOSPC: no space left');
      });

      const { reportScraperEvent: report } = await import('../telemetry.js');
      expect(() => report(basePayload)).not.toThrow();
    });

    it('silently catches mkdirSync errors', async () => {
      mockMkdirSync.mockImplementation(() => {
        throw new Error('EACCES: permission denied');
      });

      const { reportScraperEvent: report } = await import('../telemetry.js');
      expect(() => report(basePayload)).not.toThrow();
    });
  });
});

describe('flushTelemetry', () => {
  beforeEach(() => {
    mockAppendFileSync.mockReset();
    mockReadFileSync.mockReset();
    mockWriteFileSync.mockReset();
    mockMkdirSync.mockReset();
    mockStatSync.mockReset();
    vi.resetModules();
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response('ok', { status: 200 }))
    );
  });

  it('calls syncNow which reads buffer and POSTs to platform', async () => {
    // Simulate a buffered event in the JSONL file
    const event = JSON.stringify({
      product: 'scraper',
      event_type: 'compress',
      payload: basePayload,
      _ts: '2026-04-05T00:00:00Z',
    }) + '\n';

    mockReadFileSync.mockImplementation((path: string) => {
      if (typeof path === 'string' && path.includes('config.json')) {
        return JSON.stringify({ api_key: 'test-key' });
      }
      if (typeof path === 'string' && path.includes('offset')) {
        return '0';
      }
      if (typeof path === 'string' && path.includes('events.jsonl')) {
        return event;
      }
      throw new Error('ENOENT');
    });

    const { flushTelemetry } = await import('../telemetry.js');
    await flushTelemetry();

    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(url).toContain('/v1/telemetry');
    expect((init as RequestInit).headers).toEqual(
      expect.objectContaining({
        Authorization: 'Bearer test-key',
      })
    );
  });

  it('does not call fetch when buffer is empty', async () => {
    mockReadFileSync.mockImplementation((path: string) => {
      if (typeof path === 'string' && path.includes('config.json')) {
        return JSON.stringify({ api_key: 'test-key' });
      }
      if (typeof path === 'string' && path.includes('offset')) {
        return '0';
      }
      throw new Error('ENOENT');
    });

    const { flushTelemetry } = await import('../telemetry.js');
    await flushTelemetry();

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('does not call fetch when no api_key configured', async () => {
    mockReadFileSync.mockImplementation((path: string) => {
      if (typeof path === 'string' && path.includes('config.json')) {
        return JSON.stringify({});
      }
      throw new Error('ENOENT');
    });

    const { flushTelemetry } = await import('../telemetry.js');
    await flushTelemetry();

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('does not call fetch when RR_TELEMETRY=off', async () => {
    vi.stubEnv('RR_TELEMETRY', 'off');

    mockReadFileSync.mockImplementation((path: string) => {
      if (typeof path === 'string' && path.includes('config.json')) {
        return JSON.stringify({ api_key: 'test-key' });
      }
      throw new Error('ENOENT');
    });

    const { flushTelemetry } = await import('../telemetry.js');
    await flushTelemetry();

    expect(globalThis.fetch).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});
