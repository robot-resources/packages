import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export const PAYLOAD_ENTRIES = ['index.js', 'openclaw.plugin.json', 'package.json', 'lib'];

export function copyDir(src, dst) {
  const st = statSync(src);
  if (st.isDirectory()) {
    mkdirSync(dst, { recursive: true });
    for (const entry of readdirSync(src)) {
      copyDir(join(src, entry), join(dst, entry));
    }
  } else {
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
  }
}

export function prunePreviousBaks(dir, keep) {
  try {
    const baks = readdirSync(dir)
      .filter((n) => n.startsWith('.bak-'))
      .map((n) => ({ name: n, mtime: statSync(join(dir, n)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const b of baks.slice(keep)) {
      rmSync(join(dir, b.name), { recursive: true, force: true });
    }
  } catch { /* best-effort */ }
}
