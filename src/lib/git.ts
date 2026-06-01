// Git transport. EVERY git invocation goes through `git()` which calls
// execFileSync('git', argsArray, ...) — never a shell string, never string
// concatenation. This structurally kills shell bugs (pathspec globbing,
// word-splitting): a file slug is always passed as one exact path arg.
//
// Nothing in here throws to the caller; failures surface as a non-zero `status`.

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { ctmLog } from './log'

/** Result of a git invocation. `status` is 0 on success, non-zero (or 1) on failure. */
export interface GitResult {
  status: number
  stdout: string
  stderr: string
}

/** Options for {@link git}. */
export interface GitOpts {
  /** Working directory for the git process. */
  cwd?: string
  /** Extra environment to merge over process.env (e.g. non-interactive flags). */
  env?: NodeJS.ProcessEnv
  /** Hard timeout in ms (defaults to 120000). */
  timeout?: number
}

/**
 * Run `git <args...>`. NEVER throws — a thrown/non-zero exit becomes a GitResult
 * with non-zero `status`. `args` is an array; values are passed verbatim to git
 * (no shell), so paths/slugs are never glob-expanded or word-split.
 */
export function git(args: string[], opts: GitOpts = {}): GitResult {
  try {
    const stdout = execFileSync('git', args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      encoding: 'utf8',
      timeout: opts.timeout ?? 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    })
    return { status: 0, stdout, stderr: '' }
  } catch (err: unknown) {
    // execFileSync throws an Error augmented with status/stdout/stderr on non-zero exit.
    const e = err as { status?: number | null; stdout?: Buffer | string; stderr?: Buffer | string; message?: string }
    const toStr = (v: Buffer | string | undefined): string =>
      v == null ? '' : typeof v === 'string' ? v : v.toString('utf8')
    return {
      status: typeof e.status === 'number' ? e.status : 1,
      stdout: toStr(e.stdout),
      stderr: toStr(e.stderr) || e.message || 'git invocation failed',
    }
  }
}

/** Non-interactive env so git never blocks waiting for a prompt/passphrase/host key. */
function batchEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -oBatchMode=yes -oStrictHostKeyChecking=accept-new',
    ...extra,
  }
}

/**
 * Clone `url` into `dir` exactly once. If `dir` already looks like a git repo,
 * this is a no-op success. Non-interactive; never throws. Returns the GitResult.
 */
export function cloneOnce(url: string, dir: string): GitResult {
  // Already a working tree with a git dir -> nothing to do.
  const inside = git(['rev-parse', '--is-inside-work-tree'], { cwd: dir, env: batchEnv() })
  if (inside.status === 0 && inside.stdout.trim() === 'true') {
    return { status: 0, stdout: 'already cloned', stderr: '' }
  }
  // Full clone (no --depth): the storage repo is tiny, and a shallow clone makes
  // a later `pull --rebase` across diverged history fail to find a merge base,
  // producing spurious "conflict" reports in pushWithRebase.
  const res = git(['clone', url, dir], { env: batchEnv(), timeout: 300_000 })
  if (res.status !== 0) ctmLog(`clone failed for ${url}: ${res.stderr.trim()}`)
  return res
}

/**
 * Ensure the checkout has a committer identity so commits don't fail in CI-like
 * environments. Sets a local (repo-scoped) identity only if none is configured.
 * Never throws.
 */
export function ensureIdentity(checkout: string): void {
  const haveName = git(['config', '--get', 'user.name'], { cwd: checkout }).status === 0
  const haveEmail = git(['config', '--get', 'user.email'], { cwd: checkout }).status === 0
  if (!haveName) git(['config', 'user.name', 'claude-team-mem'], { cwd: checkout })
  if (!haveEmail) git(['config', 'user.email', 'claude-team-mem@users.noreply.github.com'], { cwd: checkout })
}

/** Outcome kinds for {@link pushWithRebase}. */
export type PushOutcome =
  | { ok: true; pushed: boolean; reason: string }
  | { ok: false; conflict: boolean; reason: string }

/** Options for {@link pushWithRebase}. */
export interface PushOpts {
  /** Branch to push (defaults to the checkout's current branch). */
  branch?: string
  /** Max attempts of the pull --rebase -> push loop (defaults to 3). */
  retries?: number
}

/** Return the current branch name of `checkout`, or null if it can't be determined. */
function currentBranch(checkout: string): string | null {
  const r = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: checkout })
  if (r.status !== 0) return null
  const b = r.stdout.trim()
  return b && b !== 'HEAD' ? b : null
}

/** True if `branch` in `checkout` has an upstream tracking ref configured. */
function hasUpstream(checkout: string, branch: string): boolean {
  return git(['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], { cwd: checkout }).status === 0
}

/**
 * THE one shared "land a commit safely" helper, reused by BOTH publish and
 * unshare so the retry logic never diverges.
 *
 * Contract: the caller has already staged + committed its change. This then runs
 * a bounded loop of `pull --rebase origin <branch>` -> `push`:
 *  - sets upstream explicitly via `push -u origin <branch>` when none is set;
 *  - NEVER force-pushes;
 *  - on a rebase conflict, aborts the rebase cleanly and returns `{ok:false, conflict:true}`
 *    (the caller — Claude — resolves semantically and calls again);
 *  - on a lost race (non-fast-forward push), re-pulls and retries up to `retries`.
 *
 * Never throws.
 */
export function pushWithRebase(checkout: string, opts: PushOpts = {}): PushOutcome {
  const branch = opts.branch ?? currentBranch(checkout)
  if (!branch) {
    return { ok: false, conflict: false, reason: 'could not determine current branch' }
  }
  const retries = opts.retries && opts.retries > 0 ? opts.retries : 3
  const env = batchEnv()

  let lastReason = 'push not attempted'
  for (let attempt = 1; attempt <= retries; attempt++) {
    // 1. Rebase onto the remote tip (only meaningful once an upstream exists).
    if (hasUpstream(checkout, branch)) {
      const pull = git(['pull', '--rebase', 'origin', branch], { cwd: checkout, env })
      if (pull.status !== 0) {
        // Distinguish a real rebase CONFLICT (a rebase is now in progress and must
        // be aborted) from a transient failure to reach/read the remote (offline /
        // auth / no upstream yet). Only the former is a semantic conflict Claude
        // must merge; a network failure is retried within budget.
        const conflict = rebaseInProgress(checkout)
        git(['rebase', '--abort'], { cwd: checkout, env }) // harmless if none in progress
        if (conflict) {
          return {
            ok: false,
            conflict: true,
            reason: `rebase conflict on attempt ${attempt}; aborted cleanly: ${pull.stderr.trim() || pull.stdout.trim()}`,
          }
        }
        lastReason = pull.stderr.trim() || pull.stdout.trim() || 'pull --rebase failed'
        ctmLog(`pull --rebase attempt ${attempt}/${retries} failed (no rebase in progress): ${lastReason}`)
        continue
      }
    }

    // 2. Push. Set the upstream explicitly the first time; never force.
    const pushArgs = hasUpstream(checkout, branch)
      ? ['push', 'origin', branch]
      : ['push', '-u', 'origin', branch]
    const push = git(pushArgs, { cwd: checkout, env })
    if (push.status === 0) {
      return { ok: true, pushed: true, reason: `pushed ${branch} on attempt ${attempt}` }
    }

    // Non-fast-forward / lost race -> loop to re-pull and retry. Other errors: also
    // retry within budget (the next pull surfaces the real cause), then give up.
    lastReason = push.stderr.trim() || push.stdout.trim() || 'push failed'
    ctmLog(`push attempt ${attempt}/${retries} failed: ${lastReason}`)
  }

  return { ok: false, conflict: false, reason: `push failed after ${retries} attempts: ${lastReason}` }
}

/** True if a rebase is currently in progress in `checkout` (rebase-merge/-apply dir exists). */
function rebaseInProgress(checkout: string): boolean {
  for (const p of ['rebase-merge', 'rebase-apply']) {
    const r = git(['rev-parse', '--git-path', p], { cwd: checkout })
    if (r.status === 0 && existsSync(resolve(checkout, r.stdout.trim()))) return true
  }
  return false
}

/**
 * True if `checkout` has local commits not yet on the remote — i.e. a prior
 * commit landed locally but its push failed. publish/unshare use this so a
 * byte-identical / file-absent RERUN flushes the pending commit instead of
 * reporting a local-only state as a success. Never throws.
 */
export function hasUnpushedCommits(checkout: string): boolean {
  const branch = currentBranch(checkout)
  if (!branch) return false
  let base: string | null = null
  if (hasUpstream(checkout, branch)) {
    base = `${branch}@{upstream}`
  } else if (
    git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], { cwd: checkout }).status === 0
  ) {
    base = `origin/${branch}`
  }
  if (!base) {
    // No remote-tracking ref at all -> any local commit is unpushed by definition.
    return git(['rev-list', '-n', '1', 'HEAD'], { cwd: checkout }).status === 0
  }
  const ahead = git(['rev-list', '--count', `${base}..HEAD`], { cwd: checkout })
  const n = ahead.status === 0 ? ahead.stdout.trim() : '0'
  return n !== '' && n !== '0'
}
