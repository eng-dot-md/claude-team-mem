// Logging helper. stdout is RESERVED for hook JSON (SessionStart additionalContext),
// so all diagnostic output MUST go to stderr.

/** Write a diagnostic line to stderr, prefixed for grep-ability. Never throws. */
export function ctmLog(msg: string): void {
  try {
    process.stderr.write(`[claude-team-mem] ${msg}\n`)
  } catch {
    // Never let logging break a fail-soft hook.
  }
}
