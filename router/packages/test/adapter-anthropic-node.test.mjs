import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the local server module — Phase 1 unit tests should never bind a real
// port. Each test reconfigures startLocalServer to simulate primary-bind /
// fallback-bind / failure modes.
vi.mock('../lib/local-server.js', () => ({
  startLocalServer: vi.fn(),
}));

// Mock the telemetry helper to capture emitted events without making real
// HTTP calls. The shape we capture here is what lands in Supabase.
vi.mock('../lib/adapters/_attach.js', async () => {
  const actual = await vi.importActual('../lib/adapters/_attach.js');
  return {
    ...actual,
    emitAttachEvent: vi.fn().mockResolvedValue(undefined),
  };
});

const { startLocalServer } = await import('../lib/local-server.js');
const { emitAttachEvent } = await import('../lib/adapters/_attach.js');
const { _resetLocalServerSingletonForTests } = await import('../lib/adapters/_local-server-once.js');
const { attach } = await import('../lib/adapters/anthropic-node.js');

let originalBaseUrl;
let originalAnthropicKey;

beforeEach(() => {
  vi.clearAllMocks();
  // Phase 4 introduced a process-singleton for the local server bind so
  // multiple adapters share one server. Reset between tests so each case
  // exercises the bind path independently.
  _resetLocalServerSingletonForTests();
  originalBaseUrl = process.env.ANTHROPIC_BASE_URL;
  originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
});

afterEach(() => {
  if (originalBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
  else process.env.ANTHROPIC_BASE_URL = originalBaseUrl;
  if (originalAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
});

describe('attach() — primary-port bind path', () => {
  it('emits attached=true with bound_port=18790 when primary bind succeeds', async () => {
    startLocalServer.mockResolvedValue({ port: 18790, server: {} });
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:18790/anthropic';

    await attach({ primaryBaseUrl: 'http://127.0.0.1:18790/anthropic' });

    expect(emitAttachEvent).toHaveBeenCalledTimes(1);
    const payload = emitAttachEvent.mock.calls[0][0];
    expect(payload).toMatchObject({
      sdk: 'anthropic',
      attached: true,
      bound_port: 18790,
      fallback_port: false,
    });
  });

  it('does NOT mutate ANTHROPIC_BASE_URL when primary port bound', async () => {
    startLocalServer.mockResolvedValue({ port: 18790, server: {} });
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:18790/anthropic';

    await attach({ primaryBaseUrl: 'http://127.0.0.1:18790/anthropic' });

    expect(process.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:18790/anthropic');
  });
});

describe('attach() — fallback-port bind path', () => {
  it('rewrites ANTHROPIC_BASE_URL to the OS-chosen port when primary unavailable', async () => {
    startLocalServer.mockResolvedValue({ port: 53219, server: {} });
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:18790/anthropic';

    await attach({ primaryBaseUrl: 'http://127.0.0.1:18790/anthropic' });

    expect(process.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:53219/anthropic');
  });

  it('emits attached=true with fallback_port=true', async () => {
    startLocalServer.mockResolvedValue({ port: 53219, server: {} });

    await attach({ primaryBaseUrl: 'http://127.0.0.1:18790/anthropic' });

    const payload = emitAttachEvent.mock.calls[0][0];
    expect(payload).toMatchObject({
      attached: true,
      bound_port: 53219,
      fallback_port: true,
    });
  });
});

describe('attach() — bind failure', () => {
  it('emits attached=false with reason=local_server_bind_failed when port=null', async () => {
    startLocalServer.mockResolvedValue({ port: null, server: null });

    await attach({ primaryBaseUrl: 'http://127.0.0.1:18790/anthropic' });

    expect(emitAttachEvent).toHaveBeenCalledTimes(1);
    const payload = emitAttachEvent.mock.calls[0][0];
    expect(payload).toMatchObject({
      sdk: 'anthropic',
      attached: false,
      reason: 'local_server_bind_failed',
    });
  });

  it('emits attached=false with reason=local_server_throw when startLocalServer rejects', async () => {
    startLocalServer.mockRejectedValue(new Error('synthetic bind error'));

    await attach({ primaryBaseUrl: 'http://127.0.0.1:18790/anthropic' });

    const payload = emitAttachEvent.mock.calls[0][0];
    expect(payload).toMatchObject({
      sdk: 'anthropic',
      attached: false,
      reason: 'local_server_throw',
    });
    expect(payload.error_message).toContain('synthetic bind error');
  });

  it('does NOT throw back into the caller on adapter failure', async () => {
    startLocalServer.mockRejectedValue(new Error('catastrophic'));
    await expect(attach({ primaryBaseUrl: 'http://127.0.0.1:18790/anthropic' })).resolves.toBeUndefined();
  });
});

describe('attach() — provider detection', () => {
  it('passes detected providers to startLocalServer + telemetry payload', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    startLocalServer.mockResolvedValue({ port: 18790, server: {} });

    await attach({ primaryBaseUrl: 'http://127.0.0.1:18790/anthropic' });

    expect(startLocalServer).toHaveBeenCalledWith(
      expect.objectContaining({
        detectedProviders: expect.any(Set),
      }),
    );
    const detectedSet = startLocalServer.mock.calls[0][0].detectedProviders;
    expect(detectedSet.has('anthropic')).toBe(true);

    const payload = emitAttachEvent.mock.calls[0][0];
    expect(payload.providers_detected).toContain('anthropic');
  });
});
