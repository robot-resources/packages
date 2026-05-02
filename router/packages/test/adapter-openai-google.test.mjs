import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../lib/local-server.js', () => ({
  startLocalServer: vi.fn(),
}));

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

let originalOpenaiBase;
let originalAnthropicBase;

beforeEach(() => {
  vi.clearAllMocks();
  _resetLocalServerSingletonForTests();
  originalOpenaiBase = process.env.OPENAI_BASE_URL;
  originalAnthropicBase = process.env.ANTHROPIC_BASE_URL;
});

afterEach(() => {
  if (originalOpenaiBase === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = originalOpenaiBase;
  if (originalAnthropicBase === undefined) delete process.env.ANTHROPIC_BASE_URL;
  else process.env.ANTHROPIC_BASE_URL = originalAnthropicBase;
});

describe('openai-node adapter', () => {
  it('emits attached=true when local server bind succeeds on primary port', async () => {
    startLocalServer.mockResolvedValue({ port: 18790, server: {} });
    const { attach } = await import('../lib/adapters/openai-node.js');
    await attach({ primaryBaseUrl: 'http://127.0.0.1:18790/openai/v1' });

    expect(emitAttachEvent).toHaveBeenCalledTimes(1);
    const payload = emitAttachEvent.mock.calls[0][0];
    expect(payload).toMatchObject({
      sdk: 'openai',
      attached: true,
      bound_port: 18790,
      fallback_port: false,
    });
  });

  it('rewrites OPENAI_BASE_URL when bound to fallback port', async () => {
    startLocalServer.mockResolvedValue({ port: 49231, server: {} });
    process.env.OPENAI_BASE_URL = 'http://127.0.0.1:18790/openai/v1';
    const { attach } = await import('../lib/adapters/openai-node.js');
    await attach({ primaryBaseUrl: 'http://127.0.0.1:18790/openai/v1' });

    expect(process.env.OPENAI_BASE_URL).toBe('http://127.0.0.1:49231/openai/v1');
  });

  it('emits attached=false on bind failure with reason', async () => {
    _resetLocalServerSingletonForTests();
    startLocalServer.mockResolvedValue({ port: null, server: null });
    const { attach } = await import('../lib/adapters/openai-node.js');
    await attach({ primaryBaseUrl: 'http://127.0.0.1:18790/openai/v1' });

    const payload = emitAttachEvent.mock.calls[0][0];
    expect(payload).toMatchObject({
      sdk: 'openai',
      attached: false,
      reason: 'local_server_bind_failed',
    });
  });
});

describe('google-node adapter — patch behavior', () => {
  it('patches getGenerativeModel to inject baseUrl into requestOptions', async () => {
    const { _patchModuleForTests } = await import('../lib/adapters/google-node.js');

    // Stand up a minimal google.generative-ai-shaped module to patch.
    let capturedRequestOptions = null;
    class FakeModel {}
    class FakeGoogleGenerativeAI {
      getGenerativeModel(modelParams, requestOptions) {
        capturedRequestOptions = requestOptions;
        return new FakeModel();
      }
    }
    const fakeMod = { GoogleGenerativeAI: FakeGoogleGenerativeAI };

    _patchModuleForTests(fakeMod, 18790);

    const ai = new FakeGoogleGenerativeAI();
    ai.getGenerativeModel({ model: 'gemini-1.5-flash' }, undefined);
    expect(capturedRequestOptions.baseUrl).toBe('http://127.0.0.1:18790/google/v1beta');
  });

  it('respects user-supplied baseUrl in requestOptions (no clobber)', async () => {
    const { _patchModuleForTests } = await import('../lib/adapters/google-node.js');

    let captured = null;
    class FakeGoogleGenerativeAI {
      getGenerativeModel(modelParams, requestOptions) {
        captured = requestOptions;
        return {};
      }
    }
    const fakeMod = { GoogleGenerativeAI: FakeGoogleGenerativeAI };

    _patchModuleForTests(fakeMod, 18790);

    const ai = new FakeGoogleGenerativeAI();
    ai.getGenerativeModel({ model: 'gemini-1.5-flash' }, { baseUrl: 'https://my-corp-proxy.example.com' });
    expect(captured.baseUrl).toBe('https://my-corp-proxy.example.com');
  });

  it('is idempotent — patching twice keeps the same wrapped method', async () => {
    const { _patchModuleForTests } = await import('../lib/adapters/google-node.js');

    class FakeGoogleGenerativeAI {
      getGenerativeModel() { return {}; }
    }
    const fakeMod = { GoogleGenerativeAI: FakeGoogleGenerativeAI };

    _patchModuleForTests(fakeMod);
    const after1 = FakeGoogleGenerativeAI.prototype.getGenerativeModel;
    _patchModuleForTests(fakeMod);
    const after2 = FakeGoogleGenerativeAI.prototype.getGenerativeModel;

    expect(after1).toBe(after2);
  });

  it('handles a module without GoogleGenerativeAI silently', async () => {
    const { _patchModuleForTests } = await import('../lib/adapters/google-node.js');
    expect(() => _patchModuleForTests({})).not.toThrow();
  });
});
