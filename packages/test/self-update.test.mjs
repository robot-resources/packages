import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { performSelfUpdate } from '../lib/self-update.js';
import { compareVersions, parseVersion } from '../lib/update-check.js';

// ── Helpers ─────────────────────────────────────────────────────────

function makeInstallDir(version, extraFiles = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rr-plugin-install-'));
  writeFileSync(join(dir, 'index.js'), `// plugin ${version}\nexport default { id: 'openclaw-plugin', register() {} };\n`);
  writeFileSync(join(dir, 'openclaw.plugin.json'), JSON.stringify({ id: 'openclaw-plugin' }, null, 2));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: '@robot-resources/openclaw-plugin',
    version,
    type: 'module',
    main: 'index.js',
  }, null, 2));
  mkdirSync(join(dir, 'lib'), { recursive: true });
  writeFileSync(join(dir, 'lib', 'telemetry.js'), '// stub\nexport function createTelemetry() { return { emit() {} }; }\n');
  for (const [path, content] of Object.entries(extraFiles)) {
    const full = join(dir, path);
    mkdirSync(full.replace(/\/[^/]+$/, ''), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

function buildTarball({ version, name = '@robot-resources/openclaw-plugin', coreContent }) {
  const src = mkdtempSync(join(tmpdir(), 'rr-tarball-src-'));
  const pkgDir = join(src, 'package');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name, version, type: 'module', main: 'index.js' }, null, 2),
  );
  writeFileSync(join(pkgDir, 'index.js'), `// plugin ${version}\nexport default { id: 'openclaw-plugin', register() {} };\n`);
  writeFileSync(join(pkgDir, 'openclaw.plugin.json'), JSON.stringify({ id: 'openclaw-plugin' }, null, 2));
  mkdirSync(join(pkgDir, 'lib'));
  writeFileSync(
    join(pkgDir, 'lib', 'plugin-core.js'),
    coreContent ?? `// core ${version}\nexport default { id: 'openclaw-plugin', register() {} };\n`,
  );

  const tarballPath = join(src, 'plugin.tgz');
  const res = spawnSync('tar', ['-czf', tarballPath, '-C', src, 'package'], { stdio: 'ignore' });
  if (res.status !== 0) throw new Error('tar failed');

  const buf = readFileSync(tarballPath);
  const shasum = createHash('sha1').update(buf).digest('hex');
  return { tarballPath, shasum, cleanup: () => rmSync(src, { recursive: true, force: true }) };
}

function captureTelemetry() {
  const events = [];
  return {
    client: { emit: (type, payload) => events.push({ type, payload }) },
    events,
  };
}

async function serveTarball(path) {
  // A tiny loopback server so the fetch() inside performSelfUpdate hits a real URL.
  const { createServer } = await import('node:http');
  const buf = readFileSync(path);
  const server = createServer((req, res) => {
    if (req.url === '/fail') {
      res.statusCode = 500;
      res.end();
      return;
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.end(buf);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/plugin.tgz`,
    failUrl: `http://127.0.0.1:${port}/fail`,
    close: () => new Promise((r) => server.close(r)),
  };
}

// ── Version compare ─────────────────────────────────────────────────

describe('version compare', () => {
  it('parseVersion handles dotted triplets', () => {
    expect(parseVersion('0.5.4')).toEqual([0, 5, 4]);
    expect(parseVersion('1.2.3')).toEqual([1, 2, 3]);
  });

  it('parseVersion defaults missing components to 0', () => {
    expect(parseVersion('1')).toEqual([1, 0, 0]);
    expect(parseVersion('')).toEqual([0, 0, 0]);
    expect(parseVersion(undefined)).toEqual([0, 0, 0]);
  });

  it('compareVersions orders correctly', () => {
    expect(compareVersions('0.5.4', '0.5.5')).toBe(-1);
    expect(compareVersions('0.5.5', '0.5.4')).toBe(1);
    expect(compareVersions('0.5.4', '0.5.4')).toBe(0);
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1);
  });
});

// ── performSelfUpdate ───────────────────────────────────────────────

describe('performSelfUpdate', () => {
  let installDir;
  let tarball;
  let server;

  beforeEach(async () => {
    installDir = makeInstallDir('0.5.4');
    tarball = buildTarball({ version: '0.5.5' });
    server = await serveTarball(tarball.tarballPath);
  });

  afterEach(async () => {
    rmSync(installDir, { recursive: true, force: true });
    tarball.cleanup();
    await server.close();
  });

  it('Fixture A — valid tarball: swaps files and creates .bak-<old>', async () => {
    const tel = captureTelemetry();
    const result = await performSelfUpdate({
      tarballUrl: server.url,
      shasum: tarball.shasum,
      installDir,
      telemetry: tel.client,
    });

    expect(result.ok).toBe(true);
    expect(result.from).toBe('0.5.4');
    expect(result.to).toBe('0.5.5');

    const pkg = JSON.parse(readFileSync(join(installDir, 'package.json'), 'utf-8'));
    expect(pkg.version).toBe('0.5.5');

    const bak = join(installDir, '.bak-0.5.4');
    expect(() => statSync(bak)).not.toThrow();
    const bakPkg = JSON.parse(readFileSync(join(bak, 'package.json'), 'utf-8'));
    expect(bakPkg.version).toBe('0.5.4');

    expect(() => statSync(join(installDir, '.last-update'))).not.toThrow();

    const types = tel.events.map((e) => e.type);
    expect(types).toContain('plugin_update_attempted');
    expect(types).toContain('plugin_update_succeeded');
    expect(types).toContain('plugin_update_pending_reload');
  });

  it('Fixture C — bad shasum: aborts, no swap', async () => {
    const tel = captureTelemetry();
    const result = await performSelfUpdate({
      tarballUrl: server.url,
      shasum: 'wrong-shasum-that-will-not-match',
      installDir,
      telemetry: tel.client,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('shasum_mismatch');

    // install dir unchanged
    const pkg = JSON.parse(readFileSync(join(installDir, 'package.json'), 'utf-8'));
    expect(pkg.version).toBe('0.5.4');

    // No .bak created
    const entries = readdirSync(installDir);
    expect(entries.some((e) => e.startsWith('.bak-'))).toBe(false);

    const types = tel.events.map((e) => e.type);
    expect(types).toContain('plugin_update_download_failed');
    expect(types).not.toContain('plugin_update_succeeded');
  });

  it('Fixture E — lock held (<10min): returns lock_held', async () => {
    const lockPath = join(installDir, '.update.lock');
    writeFileSync(lockPath, '');

    const tel = captureTelemetry();
    const result = await performSelfUpdate({
      tarballUrl: server.url,
      shasum: tarball.shasum,
      installDir,
      telemetry: tel.client,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('lock_held');

    const pkg = JSON.parse(readFileSync(join(installDir, 'package.json'), 'utf-8'));
    expect(pkg.version).toBe('0.5.4');
  });

  it('steals a stale lock (>10min) and proceeds', async () => {
    const lockPath = join(installDir, '.update.lock');
    writeFileSync(lockPath, '');
    // Backdate mtime to 20 min ago
    const old = new Date(Date.now() - 20 * 60 * 1_000);
    const { utimesSync } = await import('node:fs');
    utimesSync(lockPath, old, old);

    const tel = captureTelemetry();
    const result = await performSelfUpdate({
      tarballUrl: server.url,
      shasum: tarball.shasum,
      installDir,
      telemetry: tel.client,
    });

    expect(result.ok).toBe(true);
  });

  it('aborts cleanly if tarball HTTP fails', async () => {
    const tel = captureTelemetry();
    const result = await performSelfUpdate({
      tarballUrl: server.failUrl,
      shasum: tarball.shasum,
      installDir,
      telemetry: tel.client,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('download_failed');

    const types = tel.events.map((e) => e.type);
    expect(types).toContain('plugin_update_download_failed');
  });

  it('rejects tarball whose package.json has wrong name', async () => {
    const impostor = buildTarball({
      name: '@evil/impostor',
      version: '9.9.9',
    });
    const evilServer = await serveTarball(impostor.tarballPath);
    try {
      const tel = captureTelemetry();
      const result = await performSelfUpdate({
        tarballUrl: evilServer.url,
        shasum: impostor.shasum,
        installDir,
        telemetry: tel.client,
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('wrong_package');

      const pkg = JSON.parse(readFileSync(join(installDir, 'package.json'), 'utf-8'));
      expect(pkg.version).toBe('0.5.4');
    } finally {
      await evilServer.close();
      impostor.cleanup();
    }
  });

  it('prunes older .bak-* directories after a successful update', async () => {
    // Seed a stale .bak-0.4.0 with an older mtime so it's clearly pruneable
    const staleBak = join(installDir, '.bak-0.4.0');
    mkdirSync(staleBak, { recursive: true });
    writeFileSync(join(staleBak, 'marker'), '');
    const old = new Date(Date.now() - 60 * 60 * 1_000);
    const { utimesSync } = await import('node:fs');
    utimesSync(staleBak, old, old);

    const tel = captureTelemetry();
    await performSelfUpdate({
      tarballUrl: server.url,
      shasum: tarball.shasum,
      installDir,
      telemetry: tel.client,
    });

    const baks = readdirSync(installDir).filter((n) => n.startsWith('.bak-'));
    expect(baks).toEqual(['.bak-0.5.4']); // only the freshest remains
  });
});

// ── safe-load.handleLoadFailure ─────────────────────────────────────
//
// safe-load.js is written to operate on its own installDir (via import.meta.url),
// so a clean unit test needs the module to be imported from inside a tmp dir.
// Because vitest reuses the module cache and we want to exercise the filesystem
// logic deterministically, we test handleLoadFailure indirectly through the
// real plugin install dir: set up a .bak-*, copy the lib file in, import from
// there. This is heavier than the other fixtures so it's kept minimal.

import { pathToFileURL } from 'node:url';

describe('safe-load.handleLoadFailure', () => {
  let installDir;
  let stateDir;
  let origHome;

  beforeEach(() => {
    installDir = mkdtempSync(join(tmpdir(), 'rr-safe-load-install-'));
    stateDir = mkdtempSync(join(tmpdir(), 'rr-safe-load-state-'));
    origHome = process.env.HOME;
    process.env.HOME = stateDir.replace(/\/\.robot-resources$/, '').replace(/\/[^/]+$/, (m) => m); // keep parent
    // Actually we need HOME = something whose .robot-resources IS stateDir
    const parent = mkdtempSync(join(tmpdir(), 'rr-safe-load-home-'));
    mkdirSync(join(parent, '.robot-resources'), { recursive: true });
    process.env.HOME = parent;
    stateDir = join(parent, '.robot-resources');
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(installDir, { recursive: true, force: true });
    // stateDir cleaned via HOME parent
  });

  it('Fixture B — restores .bak-* payload and arms skip-until when rollback is needed', async () => {
    // Simulate: installDir has BROKEN current files + a .bak-0.5.4 with the good ones.
    // Mount lib/safe-load.js at installDir/lib/safe-load.js so its __dirname resolves correctly.
    mkdirSync(join(installDir, 'lib'), { recursive: true });
    const safeLoadSrc = readFileSync(
      join(new URL('../lib/safe-load.js', import.meta.url).pathname),
      'utf-8',
    );
    writeFileSync(join(installDir, 'lib', 'safe-load.js'), safeLoadSrc);

    // "Broken" current payload at 0.5.5
    writeFileSync(join(installDir, 'index.js'), '// broken 0.5.5\nthrow new Error("boom");\n');
    writeFileSync(join(installDir, 'package.json'), JSON.stringify({
      name: '@robot-resources/openclaw-plugin',
      version: '0.5.5',
    }, null, 2));
    writeFileSync(join(installDir, 'openclaw.plugin.json'), JSON.stringify({ id: 'openclaw-plugin' }));

    // Good backup at 0.5.4
    const bak = join(installDir, '.bak-0.5.4');
    mkdirSync(bak, { recursive: true });
    mkdirSync(join(bak, 'lib'), { recursive: true });
    writeFileSync(join(bak, 'index.js'), '// good 0.5.4\n');
    writeFileSync(join(bak, 'package.json'), JSON.stringify({
      name: '@robot-resources/openclaw-plugin',
      version: '0.5.4',
    }, null, 2));
    writeFileSync(join(bak, 'openclaw.plugin.json'), JSON.stringify({ id: 'openclaw-plugin' }));

    const mod = await import(pathToFileURL(join(installDir, 'lib', 'safe-load.js')).href);
    await mod.handleLoadFailure(new Error('simulated register crash'));

    // After rollback: current should be 0.5.4 content
    const currentPkg = JSON.parse(readFileSync(join(installDir, 'package.json'), 'utf-8'));
    expect(currentPkg.version).toBe('0.5.4');

    // A .failed-* directory captures the bad 0.5.5
    const failed = readdirSync(installDir).find((n) => n.startsWith('.failed-'));
    expect(failed).toBeDefined();
    const failedPkg = JSON.parse(readFileSync(join(installDir, failed, 'package.json'), 'utf-8'));
    expect(failedPkg.version).toBe('0.5.5');

    // Skip-until written
    const skip = readFileSync(join(stateDir, '.update-skip-until'), 'utf-8').trim();
    expect(Date.parse(skip)).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1_000);
  });
});
