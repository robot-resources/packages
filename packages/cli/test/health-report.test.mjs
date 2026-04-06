import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
}));

vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/mock/home'),
}));

vi.mock('@robot-resources/cli-core/config.mjs', () => ({
  readConfig: vi.fn(() => ({})),
}));

import { readFileSync } from 'node:fs';
import { readConfig } from '@robot-resources/cli-core/config.mjs';
import { checkHealth } from '../lib/health-report.js';

describe('checkHealth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  it('returns healthy when all components respond', async () => {
    readConfig.mockReturnValue({
      api_key: 'test-key',
    });

    // Router healthy
    fetch.mockImplementation((url) => {
      if (url.includes('127.0.0.1:3838/health')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: 'healthy', version: '1.0.0' }),
        });
      }
      if (url.includes('/health') && !url.includes('3838')) {
        return Promise.resolve({ ok: true });
      }
      return Promise.reject(new Error('unexpected url'));
    });

    // openclaw.json with plugin + scraper
    readFileSync.mockImplementation((path) => {
      if (String(path).includes('openclaw.json')) {
        return JSON.stringify({
          plugins: { entries: { 'openclaw-plugin': { enabled: true } } },
          mcp: { servers: { 'robot-resources-scraper': {} } },
        });
      }
      throw new Error('ENOENT');
    });

    const report = await checkHealth();

    expect(report.status).toBe('healthy');
    expect(report.components.router.healthy).toBe(true);
    expect(report.components.scraper.healthy).toBe(true);
    expect(report.components.platform.healthy).toBe(true);
    expect(report.components.mcp.healthy).toBe(true);
    expect(typeof report.summary).toBe('string');
  });

  it('returns partial when router is down', async () => {
    readConfig.mockReturnValue({ api_key: 'test-key' });

    fetch.mockImplementation((url) => {
      if (url.includes('127.0.0.1:3838/health')) {
        return Promise.reject(new Error('ECONNREFUSED'));
      }
      if (url.includes('/health') && !url.includes('3838')) {
        return Promise.resolve({ ok: true });
      }
      return Promise.reject(new Error('unexpected'));
    });

    readFileSync.mockImplementation((path) => {
      if (String(path).includes('openclaw.json')) {
        return JSON.stringify({
          plugins: { entries: { 'openclaw-plugin': { enabled: true } } },
          mcp: { servers: { 'robot-resources-scraper': {} } },
        });
      }
      throw new Error('ENOENT');
    });

    const report = await checkHealth();

    expect(report.status).toBe('partial');
    expect(report.components.router.healthy).toBe(false);
    expect(report.components.platform.healthy).toBe(true);
    expect(report.components.scraper.healthy).toBe(true);
    expect(report.components.mcp.healthy).toBe(true);
  });

  it('returns failed when no config.json exists', async () => {
    readConfig.mockReturnValue({});

    fetch.mockImplementation((url) => {
      if (url.includes('127.0.0.1:3838/health')) {
        return Promise.reject(new Error('ECONNREFUSED'));
      }
      return Promise.reject(new Error('no config'));
    });

    readFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const report = await checkHealth();

    expect(report.status).toBe('failed');
    expect(report.components.router.healthy).toBe(false);
    expect(report.components.platform.healthy).toBe(false);
    expect(report.components.scraper.healthy).toBe(false);
    expect(report.components.mcp.healthy).toBe(false);
    expect(report.summary).toBeTruthy();
  });

  it('handles platform unreachable with timeout gracefully', async () => {
    readConfig.mockReturnValue({ api_key: 'test-key' });

    fetch.mockImplementation((url) => {
      if (url.includes('127.0.0.1:3838/health')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: 'healthy' }),
        });
      }
      if (url.includes('/health') && !url.includes('3838')) {
        return Promise.reject(new DOMException('The operation was aborted', 'AbortError'));
      }
      return Promise.reject(new Error('unexpected'));
    });

    readFileSync.mockImplementation((path) => {
      if (String(path).includes('openclaw.json')) {
        return JSON.stringify({
          plugins: { entries: { 'openclaw-plugin': { enabled: true } } },
          mcp: { servers: { 'robot-resources-scraper': {} } },
        });
      }
      throw new Error('ENOENT');
    });

    const report = await checkHealth();

    expect(report.status).toBe('partial');
    expect(report.components.router.healthy).toBe(true);
    expect(report.components.platform.healthy).toBe(false);
    expect(report.components.platform.detail).toMatch(/timeout|unreachable/i);
  });

  it('returns partial when scraper not registered but plugin is', async () => {
    readConfig.mockReturnValue({ api_key: 'test-key' });

    fetch.mockImplementation((url) => {
      if (url.includes('127.0.0.1:3838/health')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: 'healthy' }),
        });
      }
      if (url.includes('/health') && !url.includes('3838')) {
        return Promise.resolve({ ok: true });
      }
      return Promise.reject(new Error('unexpected'));
    });

    readFileSync.mockImplementation((path) => {
      if (String(path).includes('openclaw.json')) {
        return JSON.stringify({
          plugins: { entries: { 'openclaw-plugin': { enabled: true } } },
          mcp: { servers: {} },
        });
      }
      throw new Error('ENOENT');
    });

    const report = await checkHealth();

    expect(report.status).toBe('partial');
    expect(report.components.scraper.healthy).toBe(false);
    expect(report.components.mcp.healthy).toBe(true);
  });

  it('returns correct structure shape', async () => {
    readConfig.mockReturnValue({});
    fetch.mockRejectedValue(new Error('offline'));
    readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });

    const report = await checkHealth();

    expect(report).toHaveProperty('status');
    expect(report).toHaveProperty('components');
    expect(report).toHaveProperty('summary');
    expect(report.components).toHaveProperty('router');
    expect(report.components).toHaveProperty('scraper');
    expect(report.components).toHaveProperty('platform');
    expect(report.components).toHaveProperty('mcp');
    for (const comp of Object.values(report.components)) {
      expect(comp).toHaveProperty('healthy');
      expect(comp).toHaveProperty('detail');
    }
  });

  it('does not crash when fetch is unavailable', async () => {
    readConfig.mockReturnValue({ api_key: 'key' });
    global.fetch = undefined;
    readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });

    const report = await checkHealth();

    expect(report.status).toBe('failed');
    expect(report.components.router.healthy).toBe(false);
  });

  it('handles router returning non-200', async () => {
    readConfig.mockReturnValue({ api_key: 'test-key' });

    fetch.mockImplementation((url) => {
      if (url.includes('127.0.0.1:3838/health')) {
        return Promise.resolve({ ok: false, status: 503 });
      }
      if (url.includes('/health') && !url.includes('3838')) {
        return Promise.resolve({ ok: true });
      }
      return Promise.reject(new Error('unexpected'));
    });

    readFileSync.mockImplementation((path) => {
      if (String(path).includes('openclaw.json')) {
        return JSON.stringify({
          plugins: { entries: { 'openclaw-plugin': { enabled: true } } },
          mcp: { servers: { 'robot-resources-scraper': {} } },
        });
      }
      throw new Error('ENOENT');
    });

    const report = await checkHealth();

    expect(report.components.router.healthy).toBe(false);
    expect(report.status).toBe('partial');
  });
});
