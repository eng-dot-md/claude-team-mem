// Bundle each TS entry point in src/bin/ into a self-contained, zero-runtime-dep
// ESM script under plugin/scripts/. These outputs are COMMITTED so the installed
// plugin runs under `node` with no install/build step on the user's machine.
import { build } from 'esbuild'
import { rmSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outdir = join(root, 'plugin', 'scripts')
const entries = ['load', 'publish', 'unshare', 'resolve']

rmSync(outdir, { recursive: true, force: true })
mkdirSync(outdir, { recursive: true })

await build({
  entryPoints: entries.map((e) => join(root, 'src', 'bin', `${e}.ts`)),
  outdir,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  minify: false,
  sourcemap: false,
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info',
})

console.log(`built ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} -> plugin/scripts/`)
