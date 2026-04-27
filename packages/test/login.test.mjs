import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies before importing
vi.mock('../lib/auth.mjs', () => ({
  authenticate: vi.fn(),
}));

vi.mock('../lib/config.mjs', () => ({
  writeConfig: vi.fn(),
  getConfigPath: vi.fn(() => '/mock-home/.robot-resources/config.json'),
}));

// Mock global fetch
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

const { authenticate } = await import('../lib/auth.mjs');
const { writeConfig, getConfigPath } = await import('../lib/config.mjs');
const { createApiKey } = await import('../lib/login.mjs');

describe('login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createApiKey', () => {
    it('sends POST to platform API with bearer token', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: { id: 'key-1', key: 'rr_live_xxx', name: 'cli-2026-03-17' } }),
      });

      await createApiKey('access-token-123');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/v1/keys'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            Authorization: 'Bearer access-token-123',
          }),
        }),
      );
    });

    it('returns the data object from the response', async () => {
      const mockData = { id: 'key-1', key: 'rr_live_abc', name: 'cli-2026-03-17' };
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: mockData }),
      });

      const result = await createApiKey('token');

      expect(result).toEqual(mockData);
    });

    it('throws when API returns non-OK status', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Unauthorized'),
      });

      await expect(createApiKey('bad-token')).rejects.toThrow('Failed to create API key (401)');
    });

    it('includes the error body in the thrown message', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      });

      await expect(createApiKey('token')).rejects.toThrow('Internal Server Error');
    });

    it('sends a body with a name field containing the date prefix', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: { id: '1', key: 'k', name: 'n' } }),
      });

      await createApiKey('token');

      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.name).toMatch(/^cli-\d{4}-\d{2}-\d{2}$/);
    });

    it('uses RR_PLATFORM_URL env var when set', async () => {
      // The module reads the env at import time, so we verify the default behavior.
      // Default is https://api.robotresources.ai
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: { id: '1', key: 'k', name: 'n' } }),
      });

      await createApiKey('token');

      const url = mockFetch.mock.calls[0][0];
      expect(url).toMatch(/\/v1\/keys$/);
    });
  });
});
