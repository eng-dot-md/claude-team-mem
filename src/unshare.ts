// unshare — THE ONLY DELETER of shared team memory (DESIGN §7.4, §8.6).
//
// Publish NEVER deletes. Removing a shared fact from the storage repo is an
// explicit, ownership-checked action driven by the /team-memory skill. This
// module does the *mechanical* part only:
//   1. validate the slug + structural safety (real checkout; target inside it);
//   2. sanity-check that <slug> exists in the project's memory subtree;
//   3. write a TOMBSTONE record (so the deletion is auditable and a teammate's
//      stale local symlink resolves to an explanation rather than silently
//      vanishing, and so publish later REFUSES to resurrect the slug);
//   4. `git rm` the shared file (verifying the deletion is actually STAGED — we
//      never emit a false "removed" on a no-op);
//   5. ensureIdentity -> commit only the file + tombstone -> pushWithRebase
//      (the SAME shared pull --rebase -> push helper publish uses; never force).
//
// The CALLER (the /team-memory skill) owns the ownership / confirmation gate
// BEFORE calling this. This refuses obviously-unsafe input but does not prompt.
//
// Never throws: every failure mode is reported in the returned result.

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { git, ensureIdentity, pushWithRebase, hasUnpushedCommits } from './lib/git'
import { isValidSlug, readMemory } from './lib/frontmatter'
import { pathInside } from './lib/paths'
import { ctmLog } from './lib/log'

/** Input to {@link unshare}. */
export interface UnshareOpts {
  /** Absolute path to the storage-repo checkout (must be a git work tree). */
  checkoutDir: string
  /** Absolute path to `<checkoutDir>/<org>/<repo>/memory` (must be inside the checkout). */
  targetMemoryDir: string
  /** The memory's file name, with or without a trailing `.md`. */
  slug: string
  /** One-line reason recorded in the tombstone (optional). */
  reason?: string
  /** Who performed the removal, recorded in the tombstone (optional). */
  by?: string
  /**
   * ISO-ish timestamp for the tombstone. Optional because `Date` is restricted
   * in some execution contexts; when omitted we best-effort derive one and, if
   * even that is unavailable, omit the field entirely.
   */
  at?: string
}

/** Outcome of an unshare attempt. `removed` means committed + (attempted) pushed. */
export interface UnshareResult {
  /** True once the deletion is committed locally (regardless of push success). */
  removed: boolean
  /** True only when the removal was pushed to the storage repo. */
  pushed: boolean
  /** True if a rebase conflict blocked the push (caller may refresh + retry). */
  conflict: boolean
  /** Absolute path to the tombstone written (when one was), else null. */
  tombstone: string | null
  /** Human-readable explanation for logs / skill output. */
  reason: string
  /**
   * True when the slug was not present to begin with (already gone): not an
   * error the caller should retry — report "already gone".
   */
  notFound: boolean
}

/** Normalize a slug to a `<base>.md` filename. */
function toFileName(slug: string): string {
  const s = slug.trim()
  return s.endsWith('.md') ? s : `${s}.md`
}

/** Best-effort current UTC timestamp; returns undefined if Date is unavailable. */
function nowIso(): string | undefined {
  try {
    return new Date().toISOString()
  } catch {
    return undefined
  }
}

/** Build the tombstone file content (YAML frontmatter marker + human note). */
function tombstoneContent(
  base: string,
  title: string,
  reason: string,
  by: string,
  lastAuthor: string,
  at: string | undefined,
): string {
  const fm: string[] = ['---', 'tombstone: true', `slug: ${base}`, `title: ${title}`]
  if (at) fm.push(`removedAt: ${at}`)
  fm.push(`removedBy: ${by}`, `lastAuthor: ${lastAuthor}`, '---')
  const body = [
    `This shared memory was unshared via \`/team-memory unshare ${base}\`.`,
    '',
    `Reason: ${reason}`,
    '',
    'The fact is no longer team memory. Do not re-publish it without checking',
    'with the team first. Publish refuses any slug that has a tombstone here;',
    'delete this tombstone only if the fact is later legitimately re-shared.',
    '',
  ]
  return `${fm.join('\n')}\n${body.join('\n')}`
}

/** A failure result helper (nothing removed). */
function fail(reason: string, extra?: Partial<UnshareResult>): UnshareResult {
  return {
    removed: false,
    pushed: false,
    conflict: false,
    tombstone: null,
    reason,
    notFound: false,
    ...extra,
  }
}

/**
 * Remove a shared memory: tombstone + `git rm` + commit + push. The single
 * sanctioned deletion path. Never throws; all outcomes are in the result.
 */
export function unshare(opts: UnshareOpts): UnshareResult {
  try {
    const { checkoutDir, targetMemoryDir } = opts

    // --- validate inputs -----------------------------------------------------
    if (!checkoutDir || !targetMemoryDir || !opts.slug) {
      return fail('checkoutDir, targetMemoryDir and slug are all required')
    }

    const fileName = toFileName(opts.slug)
    // isValidSlug rejects path separators / `..` / leading `/` but allows internal
    // and leading dots (so `.env-notes.md` is fine). Validate the FINAL filename.
    if (!isValidSlug(fileName)) {
      return fail(`refusing unsafe slug "${opts.slug}" (must be a bare file name)`)
    }
    const base = fileName.endsWith('.md') ? fileName.slice(0, -3) : fileName

    // --- structural safety ---------------------------------------------------
    // The target must be a memory subtree of a REAL checkout, so we can never
    // git-rm something outside the storage repo.
    if (!existsSync(join(checkoutDir, '.git'))) {
      return fail(`"${checkoutDir}" is not a git checkout`)
    }
    if (!pathInside(targetMemoryDir, checkoutDir)) {
      return fail('target dir is not inside the checkout (refusing)')
    }

    const file = join(targetMemoryDir, fileName)
    if (!existsSync(file)) {
      // The file may be absent because a PRIOR unshare removed + committed it but
      // FAILED to push: the retraction is local-only and the remote still serves the
      // fact. If the removal is committed (gone from HEAD) and commits are unpushed,
      // flush them rather than reporting a misleading "already gone".
      const relPath = relative(checkoutDir, file)
      const inHead = git(['cat-file', '-e', `HEAD:${relPath}`], { cwd: checkoutDir }).status === 0
      if (!inHead && hasUnpushedCommits(checkoutDir)) {
        const tomb = join(targetMemoryDir, '.tombstones', fileName)
        const tombstone = existsSync(tomb) ? tomb : null
        const push = pushWithRebase(checkoutDir)
        if (push.ok) {
          return {
            removed: true,
            pushed: true,
            conflict: false,
            tombstone,
            reason: `removal of ${base} was committed earlier; flushed the pending push to the remote`,
            notFound: false,
          }
        }
        return {
          removed: true,
          pushed: false,
          conflict: push.conflict,
          tombstone,
          reason: push.conflict
            ? `removal of ${base} is committed locally but a rebase conflict blocks the push; Claude must merge then re-run`
            : `removal of ${base} is committed locally but still unpushed; re-run to retry: ${push.reason}`,
          notFound: false,
        }
      }
      return fail(`no shared file "${fileName}" in ${targetMemoryDir} (nothing to remove)`, {
        notFound: true,
      })
    }

    // Only a TRACKED file is actually shared upstream. An untracked worktree file
    // (e.g. bytes written into the checkout but never published) is not something
    // the team ever received — refuse cleanly rather than writing a tombstone and
    // leaving a half-staged commit that git rejects (the pathspec matches nothing).
    const tracked = git(['ls-files', '--error-unmatch', '--', file], { cwd: checkoutDir })
    if (tracked.status !== 0) {
      return fail(`"${fileName}" exists in the checkout but is not tracked/shared upstream (nothing to unshare)`, {
        notFound: true,
      })
    }

    // --- gather provenance for the tombstone --------------------------------
    const lastAuthorRes = git(['log', '-1', '--format=%an <%ae>', '--', file], { cwd: checkoutDir })
    const lastAuthor = lastAuthorRes.status === 0 && lastAuthorRes.stdout.trim().length > 0
      ? lastAuthorRes.stdout.trim()
      : 'unknown'

    let by = (opts.by ?? '').trim()
    if (by.length === 0) {
      const cfgName = git(['config', 'user.name'], { cwd: checkoutDir })
      by = cfgName.status === 0 ? cfgName.stdout.trim() : ''
    }
    if (by.length === 0) by = 'unknown'

    const reason = (opts.reason ?? '').trim() || '(no reason given)'
    const at = opts.at && opts.at.trim().length > 0 ? opts.at.trim() : nowIso()

    // Title for a human-readable tombstone (frontmatter name, else slug base).
    const mem = readMemory(file)
    const title = mem.name && mem.name.length > 0 ? mem.name : base

    // --- write the tombstone -------------------------------------------------
    const tdir = join(targetMemoryDir, '.tombstones')
    const tfile = join(tdir, fileName)
    try {
      mkdirSync(tdir, { recursive: true })
      writeFileSync(tfile, tombstoneContent(base, title, reason, by, lastAuthor, at), 'utf8')
    } catch (err) {
      return fail(`could not write tombstone ${tfile}: ${String(err)}`)
    }

    // --- remove the shared file (and VERIFY the deletion is staged) ----------
    // `git rm` deletes the worktree file AND stages the deletion. If it fails on
    // a tracked file (lock/permission/transient), we must NOT silently leave the
    // deletion UNSTAGED — that would survive in HEAD, get pushed back, and unshare
    // would falsely report success (DESIGN §7.4/§8.6). So: try git rm; else force
    // the fs deletion + `git add -A -- <file>`; then verify the path is gone from
    // the index. If it still tracks, bail (nothing committed).
    const rm = git(['rm', '-q', '-f', '--', file], { cwd: checkoutDir })
    if (rm.status !== 0) {
      try {
        rmSync(file, { force: true })
      } catch {
        /* fall through to staging + verification */
      }
      git(['add', '-A', '--', file], { cwd: checkoutDir })
      const stillTracked = git(['ls-files', '--error-unmatch', '--', file], { cwd: checkoutDir })
      if (stillTracked.status === 0) {
        return fail(`could not stage removal of ${fileName}; aborting (nothing committed)`, {
          tombstone: tfile,
        })
      }
    }
    // Stage the tombstone too.
    git(['add', '--', tfile], { cwd: checkoutDir })

    // --- commit ONLY the removed file + the tombstone ------------------------
    // A pathspec'd commit records the staged deletion of the slug and the new
    // tombstone while ignoring any other index entry, so an out-of-band staged
    // teammate file can never ride along into this unshare push.
    ensureIdentity(checkoutDir)
    const msg =
      `chore(memory): unshare ${base}\n\n` +
      `Remove shared memory '${title}' and record a tombstone.\n` +
      `Reason: ${reason}\n` +
      `Removed-by: ${by}`
    const commit = git(['commit', '-q', '-m', msg, '--', file, tfile], { cwd: checkoutDir })
    if (commit.status !== 0) {
      return fail(`nothing committed (no staged changes?): ${commit.stderr.trim() || commit.stdout.trim()}`, {
        tombstone: tfile,
      })
    }
    ctmLog(`unshare: committed removal of ${base} + tombstone`)

    // --- pull --rebase + push with bounded retry (THE shared helper, §9) -----
    const push = pushWithRebase(checkoutDir)
    if (push.ok) {
      return {
        removed: true,
        pushed: true,
        conflict: false,
        tombstone: tfile,
        reason: `unshared ${base}; ${push.reason}`,
        notFound: false,
      }
    }

    // Committed locally but not pushed. Distinguish a rebase conflict (caller may
    // refresh + retry) from a plain push failure (commit kept; push later).
    return {
      removed: true,
      pushed: false,
      conflict: push.conflict,
      tombstone: tfile,
      reason: push.conflict
        ? `removal committed locally but a rebase conflict blocked the push: ${push.reason}`
        : `removal committed locally but the push failed: ${push.reason}`,
      notFound: false,
    }
  } catch (err) {
    return fail(`unshare failed: ${String(err)}`)
  }
}
