// bin/unshare — CLI entry for the unshare flow, invoked by the /team-memory skill:
//
//   node "$CLAUDE_PLUGIN_ROOT/scripts/unshare.mjs" \
//     --checkout-dir <dir> --target-dir <dir> --slug <slug> \
//     [--reason <text>] [--by <author>] [--at <iso>]
//
// Parses argv robustly (a flag missing its value never hangs — it errors), calls
// unshare(), prints a single JSON object on stdout, and exits with a stable code
// the skill interprets:
//   0 removed (committed; pushed)
//   2 input / structural error (bad/missing args, not a checkout, unsafe slug)
//   3 nothing to remove (already gone)
//   4 committed locally but a rebase conflict blocked the push (refresh + retry)
//   5 committed locally but the push failed (retry the push later; do NOT re-run)
//
// Note: only diagnostics go to stderr (via ctmLog); the JSON result is the only
// thing on stdout.

import { writeFileSync } from 'node:fs'
import { unshare } from '../unshare'
import type { UnshareResult } from '../unshare'
import { ctmLog } from '../lib/log'

/** The flags this entry accepts; each takes exactly one value. */
type Flag = 'checkout-dir' | 'target-dir' | 'slug' | 'reason' | 'by' | 'at'
const VALUE_FLAGS: ReadonlySet<string> = new Set<Flag>([
  'checkout-dir',
  'target-dir',
  'slug',
  'reason',
  'by',
  'at',
])

interface ParsedArgs {
  values: Partial<Record<Flag, string>>
  error?: string
}

/**
 * Parse `--flag value` and `--flag=value`. A value-flag at the end of argv with
 * no following token is an error (never consumes nothing and hangs). Unknown
 * flags are an error so typos surface instead of silently no-op'ing.
 */
function parseArgs(argv: string[]): ParsedArgs {
  const values: Partial<Record<Flag, string>> = {}
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]
    if (tok === undefined) continue
    if (!tok.startsWith('--')) {
      return { values, error: `unexpected argument "${tok}"` }
    }
    const body = tok.slice(2)
    const eq = body.indexOf('=')
    const name = eq >= 0 ? body.slice(0, eq) : body
    if (!VALUE_FLAGS.has(name)) {
      return { values, error: `unknown flag "--${name}"` }
    }
    const flag = name as Flag
    if (eq >= 0) {
      values[flag] = body.slice(eq + 1)
      continue
    }
    // Space-separated value: require a following token that is not itself a flag.
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      return { values, error: `flag "--${name}" expects a value` }
    }
    values[flag] = next
    i++
  }
  return { values }
}

/** Map an UnshareResult to the stable exit code the skill expects. */
function exitCodeFor(r: UnshareResult): number {
  if (r.notFound) return 3
  if (r.removed && r.pushed) return 0
  if (r.removed && r.conflict) return 4
  if (r.removed) return 5 // committed but not pushed (non-conflict push failure)
  return 2 // input / structural error: nothing committed
}

function printResult(result: UnshareResult): void {
  // Synchronous fd-1 write so a large result flushes before process.exit (see bin/load.ts).
  writeFileSync(1, JSON.stringify(result) + '\n')
}

function main(): void {
  const { values, error } = parseArgs(process.argv.slice(2))

  if (error) {
    ctmLog(`unshare: ${error}`)
    printResult({
      removed: false,
      pushed: false,
      conflict: false,
      tombstone: null,
      reason: error,
      notFound: false,
    })
    process.exit(2)
  }

  const checkoutDir = values['checkout-dir'] ?? ''
  const targetMemoryDir = values['target-dir'] ?? ''
  const slug = values['slug'] ?? ''

  if (!checkoutDir || !targetMemoryDir || !slug) {
    const reason = 'usage: --checkout-dir <dir> --target-dir <dir> --slug <slug> [--reason <text>] [--by <author>]'
    ctmLog(`unshare: missing required flags. ${reason}`)
    printResult({
      removed: false,
      pushed: false,
      conflict: false,
      tombstone: null,
      reason,
      notFound: false,
    })
    process.exit(2)
  }

  const result = unshare({
    checkoutDir,
    targetMemoryDir,
    slug,
    ...(values.reason !== undefined ? { reason: values.reason } : {}),
    ...(values.by !== undefined ? { by: values.by } : {}),
    ...(values.at !== undefined ? { at: values.at } : {}),
  })

  printResult(result)
  process.exit(exitCodeFor(result))
}

main()
