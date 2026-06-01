// bin/resolve — CLI entry that prints the resolved team-memory paths as JSON so
// the /team-memory and /share-memory skills consume ONE machine-readable
// resolution instead of re-deriving the storage URL / checkout dir / project key /
// native dir in bash (which would silently drift from src/resolve.ts — the tested
// source of truth). It also performs the one-time clone (resolve() calls
// cloneOnce, a FULL clone), so skills never `git clone` themselves (no shallow
// checkout that would break a later pull --rebase).
//
//   node "$CLAUDE_PLUGIN_ROOT/scripts/resolve.mjs" [--cwd <projectRoot>]
//
// Prints exactly one JSON object (the Resolution: enabled, reason, and when
// enabled storageUrl/checkoutDir/projectKey/targetMemoryDir/nativeMemoryDir) on
// stdout and exits 0. Diagnostics go to stderr (ctmLog). Never throws.

import { writeFileSync } from 'node:fs'
import type { Resolution } from '../types'
import { resolve as resolveTeamMemory } from '../resolve'
import { ctmLog } from '../lib/log'

/** Read an optional `--cwd <path>` / `--cwd=<path>` override; else null. */
function cwdArg(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]
    if (tok === '--cwd') {
      const v = argv[i + 1]
      return typeof v === 'string' && v.length > 0 && !v.startsWith('--') ? v : null
    }
    if (typeof tok === 'string' && tok.startsWith('--cwd=')) {
      const v = tok.slice('--cwd='.length)
      if (v.length > 0) return v
    }
  }
  return null
}

function main(): void {
  let result: Resolution
  try {
    const projectRoot = cwdArg(process.argv.slice(2)) ?? process.cwd()
    result = resolveTeamMemory(projectRoot)
  } catch (err) {
    ctmLog(`resolve entry failed: ${String(err)}`)
    result = { enabled: false, reason: `resolve entry failed: ${String(err)}` }
  }
  writeFileSync(1, JSON.stringify(result) + '\n')
}

main()
process.exit(0)
