// SessionStart hook entrypoint (DESIGN §6). Wired in plugin/hooks/hooks.json as a
// `command` hook that runs `node plugin/scripts/load.mjs` (bundled from this file).
//
// Contract:
//  - Claude Code pipes the SessionStart hook payload as JSON on stdin; we read its
//    `cwd` to locate the project root (falling back to process.cwd()).
//  - We call buildSessionContext and, when it returns a non-null context, print
//    EXACTLY one JSON object to stdout:
//      {"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}
//    When context is null we print NOTHING (no injection).
//  - stdout is reserved for that one object; all diagnostics go to stderr (ctmLog).
//  - EVERYTHING is wrapped in try/catch and we ALWAYS exit 0 — a load failure must
//    never block or fail session start.

import { readFileSync, writeFileSync } from 'node:fs'
import { buildSessionContext } from '../load'
import { ctmLog } from '../lib/log'

/**
 * Read the SessionStart hook JSON from stdin (fd 0) if anything was piped, and
 * extract its `cwd`. Returns null when there's no payload or no usable cwd.
 * Never throws: a closed/empty/non-pipe stdin or malformed JSON all yield null.
 */
function cwdFromStdin(): string | null {
  let raw = ''
  try {
    raw = readFileSync(0, 'utf8')
  } catch {
    // No stdin available (interactive fd, closed pipe, etc.) — fine.
    return null
  }
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (typeof parsed === 'object' && parsed !== null) {
      const cwd = (parsed as Record<string, unknown>).cwd
      if (typeof cwd === 'string' && cwd.trim().length > 0) return cwd
    }
  } catch {
    // Malformed payload — degrade to process.cwd().
  }
  return null
}

function main(): void {
  try {
    const projectRoot = cwdFromStdin() ?? process.cwd()
    const { context } = buildSessionContext(projectRoot)
    if (context !== null && context.length > 0) {
      const payload = {
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: context,
        },
      }
      // Write SYNCHRONOUSLY to fd 1. SessionStart hooks run with stdout as a pipe
      // (Claude Code captures it; it is never a TTY). `process.stdout.write()` is
      // async there: an oversized write (> the ~64 KiB OS pipe buffer) does NOT
      // flush before `process.exit()`, which would truncate the JSON mid-string
      // and silently corrupt the single load-bearing output of the plugin.
      // writeFileSync blocks until every byte is handed to the kernel.
      writeFileSync(1, JSON.stringify(payload))
    }
    // context === null -> print nothing (no injection).
  } catch (err) {
    // Absolute backstop — never throw out of the hook.
    ctmLog(`load entry failed: ${String(err)}`)
  }
}

main()
// Always succeed: a non-zero exit (or thrown error) could block session start.
process.exit(0)
