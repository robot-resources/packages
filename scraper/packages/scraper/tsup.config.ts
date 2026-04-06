import { defineConfig } from 'tsup';

export default defineConfig([
  // Main library (ESM + CJS)
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    treeshake: true,
    minify: false,
    target: 'node18',
    outDir: 'dist',
  },
  // MCP server entry point (ESM only, with shebang)
  {
    entry: ['src/mcp-entry.ts'],
    format: ['esm'],
    dts: false,
    splitting: false,
    sourcemap: false,
    clean: false,
    treeshake: true,
    minify: false,
    target: 'node18',
    outDir: 'dist',
    banner: { js: '#!/usr/bin/env node' },
    external: ['@modelcontextprotocol/sdk', 'zod'],
  },
]);
