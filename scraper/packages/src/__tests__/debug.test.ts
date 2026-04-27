/**
 * Debug data output tests
 * TKT-SCRAPER-110: Debug ring buffers for Agent E2E Test Lab
 *
 * Tests pushDebugEntry behavior: env gating, ring buffer eviction,
 * directory creation, file writing, zero overhead when off.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockWriteFileSync, mockMkdirSync } = vi.hoisted(() => ({
  mockWriteFileSync: vi.fn(),
  mockMkdirSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  writeFileSync: mockWriteFileSync,
  mkdirSync: mockMkdirSync,
}));

describe('pushDebugEntry', () => {
  beforeEach(() => {
    vi.resetModules();
    mockWriteFileSync.mockReset();
    mockMkdirSync.mockReset();
    delete process.env.RR_DEBUG;
    delete process.env.RR_DEBUG_RETAIN;
  });

  afterEach(() => {
    delete process.env.RR_DEBUG;
    delete process.env.RR_DEBUG_RETAIN;
  });

  it('does NOT write files when RR_DEBUG is unset', async () => {
    const { pushDebugEntry } = await import('../debug.js');

    pushDebugEntry('test-file', { url: 'https://example.com' });

    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expect(mockMkdirSync).not.toHaveBeenCalled();
  });

  it('does NOT write files when RR_DEBUG is "0"', async () => {
    process.env.RR_DEBUG = '0';
    const { pushDebugEntry } = await import('../debug.js');

    pushDebugEntry('test-file', { url: 'https://example.com' });

    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('writes JSON file when RR_DEBUG=1', async () => {
    process.env.RR_DEBUG = '1';
    const { pushDebugEntry } = await import('../debug.js');

    pushDebugEntry('scraper-compressions', { url: 'https://example.com', success: true });

    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('debug'),
      { recursive: true },
    );
    expect(mockWriteFileSync).toHaveBeenCalledOnce();

    const [path, content] = mockWriteFileSync.mock.calls[0];
    expect(path).toContain('scraper-compressions.json');

    const parsed = JSON.parse(content as string);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      url: 'https://example.com',
      success: true,
    });
    expect(parsed[0].timestamp).toBeDefined();
  });

  it('creates directory with recursive option', async () => {
    process.env.RR_DEBUG = '1';
    const { pushDebugEntry } = await import('../debug.js');

    pushDebugEntry('test-file', { data: 1 });

    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('.robot-resources'),
      { recursive: true },
    );
  });

  it('accumulates entries in ring buffer across calls', async () => {
    process.env.RR_DEBUG = '1';
    const { pushDebugEntry } = await import('../debug.js');

    pushDebugEntry('test-buf', { n: 1 });
    pushDebugEntry('test-buf', { n: 2 });
    pushDebugEntry('test-buf', { n: 3 });

    expect(mockWriteFileSync).toHaveBeenCalledTimes(3);

    // Last write should contain all 3 entries
    const lastContent = mockWriteFileSync.mock.calls[2][1] as string;
    const parsed = JSON.parse(lastContent);
    expect(parsed).toHaveLength(3);
    expect(parsed[0].n).toBe(1);
    expect(parsed[2].n).toBe(3);
  });

  it('evicts oldest entries when exceeding retain limit', async () => {
    process.env.RR_DEBUG = '1';
    process.env.RR_DEBUG_RETAIN = '3';
    const { pushDebugEntry } = await import('../debug.js');

    pushDebugEntry('evict-test', { n: 1 });
    pushDebugEntry('evict-test', { n: 2 });
    pushDebugEntry('evict-test', { n: 3 });
    pushDebugEntry('evict-test', { n: 4 });

    const lastContent = mockWriteFileSync.mock.calls[3][1] as string;
    const parsed = JSON.parse(lastContent);
    expect(parsed).toHaveLength(3);
    // Oldest (n:1) should be evicted
    expect(parsed[0].n).toBe(2);
    expect(parsed[2].n).toBe(4);
  });

  it('handles RR_DEBUG_RETAIN=0 by writing empty array', async () => {
    process.env.RR_DEBUG = '1';
    process.env.RR_DEBUG_RETAIN = '0';
    const { pushDebugEntry } = await import('../debug.js');

    pushDebugEntry('zero-test', { n: 1 });

    const content = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = JSON.parse(content);
    expect(parsed).toHaveLength(0);
  });

  it('silently catches writeFileSync errors', async () => {
    process.env.RR_DEBUG = '1';
    mockWriteFileSync.mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });

    const { pushDebugEntry } = await import('../debug.js');

    // Must not throw
    expect(() => pushDebugEntry('fail-test', { data: 1 })).not.toThrow();
  });

  it('maintains separate buffers per file name', async () => {
    process.env.RR_DEBUG = '1';
    const { pushDebugEntry } = await import('../debug.js');

    pushDebugEntry('file-a', { a: 1 });
    pushDebugEntry('file-b', { b: 1 });
    pushDebugEntry('file-a', { a: 2 });

    // file-a should have 2 entries, file-b should have 1
    const fileACalls = mockWriteFileSync.mock.calls.filter(
      (c: unknown[]) => (c[0] as string).includes('file-a'),
    );
    const lastA = JSON.parse(fileACalls[fileACalls.length - 1][1] as string);
    expect(lastA).toHaveLength(2);

    const fileBCalls = mockWriteFileSync.mock.calls.filter(
      (c: unknown[]) => (c[0] as string).includes('file-b'),
    );
    const lastB = JSON.parse(fileBCalls[fileBCalls.length - 1][1] as string);
    expect(lastB).toHaveLength(1);
  });

  it('adds timestamp to every entry automatically', async () => {
    process.env.RR_DEBUG = '1';
    const { pushDebugEntry } = await import('../debug.js');

    pushDebugEntry('ts-test', { url: 'test' });

    const content = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = JSON.parse(content);
    expect(parsed[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
