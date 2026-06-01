// Entry point for the publish MECHANICS, invoked by the /share-memory skill as:
//
//   node "$CLAUDE_PLUGIN_ROOT/scripts/publish.mjs" \
//     --checkout-dir <checkoutDir> \
//     --target-dir   <targetMemoryDir> \
//     --native-dir   <nativeMemoryDir> \
//     [--message <msg>] [--retries <n>] \
//     --slug <foo.md> [--slug <bar.md> ...]
//
// It parses argv, calls publish(), prints EXACTLY one JSON object to stdout, and
// exits 0 on a normal run. A malformed invocation (a flag missing its value, or
// an unknown flag) errors cleanly to stderr and exits 2 WITHOUT hanging.
//
// All diagnostics go to stderr (ctmLog); stdout carries only the result JSON so
// the skill can parse it deterministically.

import { writeFileSync } from 'node:fs'
import { publish } from '../publish'
import type { PublishOpts, PublishResult } from '../publish'
import { ctmLog } from '../lib/log'

/** Print the result JSON to stdout and exit 0. */
function emit(result: PublishResult): never {
  // Synchronous write to fd 1 (NOT process.stdout.write, which is async on a pipe):
  // a large result (many slugs, long notes) must fully flush before process.exit
  // or the skill's JSON.parse sees a truncated object. Same rationale as bin/load.ts.
  writeFileSync(1, JSON.stringify(result) + '\n')
  process.exit(0)
}

/** Print a parse error to stderr and exit non-zero (never hangs). */
function fail(msg: string): never {
  ctmLog(`publish: ${msg}`)
  process.exit(2)
}

interface ParsedArgs {
  checkoutDir?: string
  targetDir?: string
  nativeDir?: string
  message?: string
  retries?: number
  slugs: string[]
}

/**
 * Parse argv. Flags that take a value REQUIRE the next token to be present and
 * not itself look like a flag — a missing value errors cleanly instead of
 * swallowing the next flag or hanging. `--slug` is repeatable.
 */
function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { slugs: [] }
  let i = 0

  // Consume the value for a value-taking flag, validating it exists and is not
  // another flag (so `--message --slug x` errors rather than eating `--slug`).
  const takeValue = (flag: string): string => {
    const v = argv[i + 1]
    if (v === undefined) fail(`missing value for ${flag}`)
    if (v.startsWith('--')) fail(`missing value for ${flag} (got flag ${v})`)
    i += 2
    return v
  }

  while (i < argv.length) {
    const arg = argv[i]
    if (arg === undefined) break
    switch (arg) {
      case '--checkout-dir':
        out.checkoutDir = takeValue(arg)
        break
      case '--target-dir':
        out.targetDir = takeValue(arg)
        break
      case '--native-dir':
        out.nativeDir = takeValue(arg)
        break
      case '--message':
        out.message = takeValue(arg)
        break
      case '--retries': {
        const raw = takeValue(arg)
        const n = Number(raw)
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
          fail(`--retries must be a positive integer (got ${raw})`)
        }
        out.retries = n
        break
      }
      case '--slug':
        out.slugs.push(takeValue(arg))
        break
      default:
        fail(`unknown argument: ${arg}`)
    }
  }

  return out
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2))

  if (!parsed.checkoutDir) fail('missing required --checkout-dir')
  if (!parsed.targetDir) fail('missing required --target-dir')

  const opts: PublishOpts = {
    checkoutDir: parsed.checkoutDir,
    targetMemoryDir: parsed.targetDir,
    slugs: parsed.slugs,
    ...(parsed.nativeDir !== undefined ? { nativeMemoryDir: parsed.nativeDir } : {}),
    ...(parsed.message !== undefined ? { message: parsed.message } : {}),
    ...(parsed.retries !== undefined ? { retries: parsed.retries } : {}),
  }

  // publish() never throws, but wrap defensively so the entry always emits JSON.
  try {
    emit(publish(opts))
  } catch (err) {
    emit({
      published: false,
      pushed: false,
      committed: false,
      reason: `unexpected error: ${String(err)}`,
      commit: '',
      slugs: [],
    })
  }
}

main()
