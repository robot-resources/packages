import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate plugin-heal's state dir to a per-test tmpdir via HOME.
let tmpHome;

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(() => ({ status: 0, stdout: '', stderr: '' })),
}));

beforeEach(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'rr-plugin-heal-'));
  process.env.HOME = tmpHome;
  vi.resetModules();
});

afterEach(() => {
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('runPluginHeal', () => {
  it('no-ops when /health is healthy', async () => {
    const emit = vi.fn();
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'healthy' }) });

    const { runPluginHeal } = await import('../lib/plugin-heal.js');
    await runPluginHeal({ routerUrl: 'http://localhost:3838', telemetry: { emit } });

    expect(emit).toHaveBeenCalledWith('plugin_heal_skipped', expect.objectContaining({ reason: 'already_healthy' }));
  });

  it('respects the 1h throttle', async () => {
    // Pre-seed a fresh throttle marker.
    mkdirSync(join(tmpHome, '.robot-resources'), { recursive: true });
    writeFileSync(join(tmpHome, '.robot-resources', '.plugin-heal-check'), new Date().toISOString());

    const emit = vi.fn();
    globalThis.fetch = vi.fn();

    const { runPluginHeal } = await import('../lib/plugin-heal.js');
    await runPluginHeal({ routerUrl: 'http://localhost:3838', telemetry: { emit } });

    // Throttle-fresh → bail before pinging health
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('attempts to heal and emits plugin_heal_failed when router never comes up', async () => {
    const emit = vi.fn();
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false });

    const tryStartRouter = vi.fn().mockResolvedValue(false);
    const { runPluginHeal } = await import('../lib/plugin-heal.js');
    await runPluginHeal({
      routerUrl: 'http://localhost:3838',
      telemetry: { emit },
      tryStartRouter,
    });

    expect(emit).toHaveBeenCalledWith('plugin_heal_attempted', expect.anything());
    expect(emit).toHaveBeenCalledWith('plugin_heal_failed', expect.anything());
  }, 30_000);

  it('releases the lock even when an unexpected error occurs', async () => {
    // Throw from fetch to simulate a weird network error during the ping.
    globalThis.fetch = vi.fn().mockImplementation(() => { throw new Error('boom'); });

    const { runPluginHeal } = await import('../lib/plugin-heal.js');
    await runPluginHeal({ routerUrl: 'http://localhost:3838', telemetry: { emit: vi.fn() } });

    const lockPath = join(tmpHome, '.robot-resources', '.heal.lock');
    // Either never created the lock, or created + released it — never left held.
    if (existsSync(lockPath)) {
      const pid = parseInt(readFileSync(lockPath, 'utf-8'), 10);
      expect(pid === process.pid).toBe(false);
    }
  }, 30_000);
});
