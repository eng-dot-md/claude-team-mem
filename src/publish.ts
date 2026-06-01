// Publish MECHANICS for the team-memory share path. This module does NOT
// classify, sanitize, or merge — that reasoning lives in the /share-memory skill
// (Claude). By the time publish() runs, the skill has ALREADY written the final,
// sanitized, semantically-merged bytes for each slug into the checkout's target
// memory dir (<targetMemoryDir>/<slug>.md). publish()'s job is purely:
//
//   1. validate slugs (skip invalid)
//   2. provenance backstop: skip any candidate whose frontmatter says
//      metadata.origin === "team" (never re-publish team-origin files)
//   3. tombstone guard: skip + report any slug with a tombstone under
//      <targetMemoryDir>/.tombstones/ (a retracted fact must not be resurrected)
//   4. stage EXACTLY the named slug paths (git add with an exact path arg), never
//      `git add -A`, never `git rm`; skip a path that is byte-identical to HEAD
//      (dedupe, no churn)
//   5. ensureIdentity + commit ONLY those staged pathspecs (so an out-of-band
//      staged teammate file can never ride along)
//   6. land it via the SHARED pushWithRebase helper (pull --rebase -> push with
//      bounded retry; never force-push; aborts cleanly on a rebase conflict)
//   7. after a SUCCESSFUL push, for each published slug convert the native REAL
//      file to an ABSOLUTE symlink INTO the checkout ONLY if its bytes are
//      byte-identical to the pushed copy; otherwise KEEP the local real file
//      (sanitized/merged — no data loss; DESIGN §7.8)
//
// publish() NEVER deletes from the checkout (DESIGN §7.4). Deletion is only via
// /team-memory unshare (tombstone + ownership check). Never throws.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { git, ensureIdentity, pushWithRebase, hasUnpushedCommits } from './lib/git'
import type { GitResult } from './lib/git'
import { isValidSlug, readMemory } from './lib/frontmatter'
import { pathInside } from './lib/paths'
import { ctmLog } from './lib/log'

/** Per-slug outcome of a publish run. */
export interface PublishSlugResult {
  /** The slug (basename) this result is about. */
  slug: string
  /** Was the slug accepted (valid, not skipped for provenance/tombstone)? */
  accepted: boolean
  /** Is the file present in the checkout target dir? */
  inCheckout: boolean
  /** Did we (or a prior run) convert/leave the native entry as a symlink into the checkout? */
  linked: boolean
  /** Did we keep the native real file as-is (sanitized/merged, or push failed)? */
  keptLocal: boolean
  /** Human-readable explanation of this slug's outcome. */
  note: string
}

/** Overall result of a publish run. Mirrors the JSON the skill reads. */
export interface PublishResult {
  /** True if a push succeeded OR the run was a clean no-op. */
  published: boolean
  /** Did we actually push a commit? */
  pushed: boolean
  /** Did we create a commit? */
  committed: boolean
  /** Human-readable summary (quote to the user). */
  reason: string
  /** Resulting commit sha (empty if none). */
  commit: string
  /** Per-slug outcomes (one per input slug, in order). */
  slugs: PublishSlugResult[]
}

/** Options for {@link publish}. */
export interface PublishOpts {
  /** Absolute path to the local checkout of the storage repo (a git work tree). */
  checkoutDir: string
  /** Absolute path to <checkoutDir>/<projectKey>/memory (where shared bytes live). */
  targetMemoryDir: string
  /** Absolute path to this project's native memory dir, or empty/undefined if unresolved. */
  nativeMemoryDir?: string
  /** The exact set of slug basenames (e.g. "foo.md") the skill wrote into the target dir. */
  slugs: string[]
  /** Commit message (defaults to a generic team-memory message). */
  message?: string
  /** Max push attempts (forwarded to the shared pushWithRebase; default 3). */
  retries?: number
}

/** A slug accepted for staging, plus its resolved target path. */
interface Accepted {
  slug: string
  /** Absolute path of the file in the checkout target dir. */
  targetPath: string
}

/** Byte-compare two files. True only if both exist and are byte-identical. */
function sameBytes(a: string, b: string): boolean {
  try {
    if (!existsSync(a) || !existsSync(b)) return false
    const ba = readFileSync(a)
    const bb = readFileSync(b)
    return ba.length === bb.length && ba.equals(bb)
  } catch {
    return false
  }
}

/** True if `path` exists and is a symlink (does not follow the link). */
function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/** True if `path` exists at all (symlink, file, or dir; does not follow). */
function lexists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * Read a symlink's raw target and resolve it to an absolute path against the
 * link's own directory. Uses readlink semantics, so a dangling target still
 * resolves (we never require the target to exist). Returns null on failure.
 */
function resolveSymlink(linkPath: string): string | null {
  try {
    const target = readlinkSync(linkPath)
    return resolve(dirname(resolve(linkPath)), target)
  } catch {
    return null
  }
}

/**
 * Stage exactly `targetPath` (an absolute path) in the checkout. We ALWAYS issue
 * the `git add -- <path>`: staging a file byte-identical to its tracked HEAD copy
 * is a no-op in the index, while an untracked/changed file gets added — so the
 * authoritative "is there anything to commit?" decision is deferred to a single
 * `git diff --cached --quiet` over the staged pathspecs (handles the byte-
 * identical dedupe and untracked-new cases uniformly). We never `git add -A` and
 * never `git rm`, so only the exact named path is touched. Returns the GitResult.
 */
function stageExact(checkoutDir: string, targetPath: string): GitResult {
  return git(['add', '--', targetPath], { cwd: checkoutDir })
}

/**
 * Build a "kept local / not pushed" result for an accepted slug (used on every
 * path where we did NOT push successfully). Makes no filesystem changes.
 */
function keptLocalResult(acc: Accepted, note: string): PublishSlugResult {
  return {
    slug: acc.slug,
    accepted: true,
    inCheckout: existsSync(acc.targetPath),
    linked: false,
    keptLocal: true,
    note,
  }
}

/**
 * Post-push: decide what to do with the NATIVE copy of each accepted slug now
 * that the checkout copy is the source of truth.
 *   - checkout copy missing            -> inCheckout=false, keptLocal=true
 *   - no native dir resolved           -> record state, change nothing
 *   - native already an "ours" symlink -> already team; report linked
 *   - native is some OTHER symlink      -> leave it; keptLocal (unrelated link)
 *   - no native entry                  -> create an absolute symlink into checkout
 *   - native real file, bytes ==       -> replace with an absolute symlink (atomic)
 *   - native real file, bytes DIFFER   -> KEEP it (sanitized/merged; DESIGN §7.8)
 * Never deletes the checkout copy.
 */
function linkBackPushed(
  accepted: Accepted[],
  nativeMemoryDir: string | undefined,
): PublishSlugResult[] {
  const results: PublishSlugResult[] = []

  for (const acc of accepted) {
    const src = acc.targetPath // checkout copy (absolute)

    if (!existsSync(src)) {
      results.push({
        slug: acc.slug,
        accepted: true,
        inCheckout: false,
        linked: false,
        keptLocal: true,
        note: 'checkout copy missing after push; local kept',
      })
      continue
    }

    if (!nativeMemoryDir) {
      // No native dir resolved (load degraded / non-darwin). Record state against
      // the checkout; make no FS changes in the native dir.
      results.push({
        slug: acc.slug,
        accepted: true,
        inCheckout: true,
        linked: false,
        keptLocal: false,
        note: 'no native dir; checkout updated, nothing linked',
      })
      continue
    }

    const dst = join(nativeMemoryDir, acc.slug) // native copy
    const absSrc = resolve(src)

    // Existing native symlink: only treat it as "ours" if it already resolves to
    // THIS checkout copy. A symlink pointing elsewhere is an unrelated link we
    // must not silently retarget.
    if (isSymlink(dst)) {
      const real = resolveSymlink(dst)
      if (real === absSrc) {
        results.push({
          slug: acc.slug,
          accepted: true,
          inCheckout: true,
          linked: true,
          keptLocal: false,
          note: 'native already a symlink into the checkout (already team)',
        })
        continue
      }
      // A symlink that does NOT resolve to our checkout copy: leave it, report.
      results.push({
        slug: acc.slug,
        accepted: true,
        inCheckout: true,
        linked: false,
        keptLocal: true,
        note: 'native is an unrelated symlink (not into this checkout); left as-is',
      })
      continue
    }

    // No native entry at all: create an absolute symlink so native recall follows it.
    if (!lexists(dst)) {
      try {
        mkdirSync(nativeMemoryDir, { recursive: true })
        symlinkSync(absSrc, dst)
        results.push({
          slug: acc.slug,
          accepted: true,
          inCheckout: true,
          linked: true,
          keptLocal: false,
          note: 'created absolute symlink into the checkout (no prior native file)',
        })
      } catch (err) {
        results.push({
          slug: acc.slug,
          accepted: true,
          inCheckout: true,
          linked: false,
          keptLocal: false,
          note: `could not create symlink (${String(err)}); checkout has the copy`,
        })
      }
      continue
    }

    // Native is a REAL file. Convert to a symlink ONLY if byte-identical.
    if (sameBytes(dst, src)) {
      const tmp = `${dst}.ctmlink.${process.pid}`
      try {
        rmSync(tmp, { force: true })
        symlinkSync(absSrc, tmp)
        renameSync(tmp, dst) // atomic replace of the real file with the symlink
        results.push({
          slug: acc.slug,
          accepted: true,
          inCheckout: true,
          linked: true,
          keptLocal: false,
          note: 'identical to pushed copy; converted local real file to absolute symlink',
        })
      } catch (err) {
        try {
          rmSync(tmp, { force: true })
        } catch {
          /* ignore */
        }
        results.push({
          slug: acc.slug,
          accepted: true,
          inCheckout: true,
          linked: false,
          keptLocal: true,
          note: `identical but symlink conversion failed (${String(err)}); local real file kept`,
        })
      }
      continue
    }

    // Bytes differ (sanitized / merged). KEEP the local real file (DESIGN §7.8).
    results.push({
      slug: acc.slug,
      accepted: true,
      inCheckout: true,
      linked: false,
      keptLocal: true,
      note: 'differs from pushed copy (sanitized/merged); local real file kept (offer to split into a personal memory)',
    })
  }

  return results
}

/**
 * Publish the named slugs from the checkout target dir to the storage repo.
 * Mechanics only — see the module header. Never throws; always returns a result.
 */
export function publish(opts: PublishOpts): PublishResult {
  const { checkoutDir, targetMemoryDir } = opts
  const nativeDir = opts.nativeMemoryDir && opts.nativeMemoryDir.length > 0 ? opts.nativeMemoryDir : undefined
  const message = opts.message && opts.message.length > 0 ? opts.message : 'team-memory: publish shared memory'

  // --- Input validation (fail-soft: return a result, never throw) ---
  if (!checkoutDir || !existsSync(join(checkoutDir, '.git'))) {
    return {
      published: false,
      pushed: false,
      committed: false,
      reason: `checkout dir missing or not a git repo: ${checkoutDir}`,
      commit: '',
      slugs: [],
    }
  }
  if (!targetMemoryDir) {
    return {
      published: false,
      pushed: false,
      committed: false,
      reason: 'no targetMemoryDir provided',
      commit: '',
      slugs: [],
    }
  }
  // Structural safety (mirrors unshare): the target MUST be inside the checkout, so
  // a bad --target-dir can never make us `git add` or symlink-back a path outside
  // the storage repo.
  if (!pathInside(targetMemoryDir, checkoutDir)) {
    return {
      published: false,
      pushed: false,
      committed: false,
      reason: `target dir is not inside the checkout (refusing): ${targetMemoryDir}`,
      commit: '',
      slugs: [],
    }
  }

  const tombstoneDir = join(targetMemoryDir, '.tombstones')
  const perSlug: PublishSlugResult[] = []
  const accepted: Accepted[] = []

  // --- Per-slug acceptance: validate, provenance backstop, tombstone guard ---
  for (const rawSlug of opts.slugs) {
    const trimmed = (rawSlug ?? '').trim()
    // Normalize to a `<base>.md` filename so a bare slug (`foo`) maps to the same
    // on-disk file as unshare's toFileName (`foo.md`) and as load's *.md listing;
    // otherwise publish could write a file neither load surfaces nor unshare can retract.
    const slug = trimmed.length > 0 && !trimmed.endsWith('.md') ? `${trimmed}.md` : trimmed

    if (!isValidSlug(slug)) {
      perSlug.push({
        slug: rawSlug ?? '',
        accepted: false,
        inCheckout: false,
        linked: false,
        keptLocal: false,
        note: 'invalid slug (separator, leading slash, or `..` component); skipped',
      })
      continue
    }

    const targetPath = join(targetMemoryDir, slug)

    // Tombstone guard: a retracted fact must NOT be resurrected by re-publish.
    if (existsSync(join(tombstoneDir, slug))) {
      perSlug.push({
        slug,
        accepted: false,
        inCheckout: existsSync(targetPath),
        linked: false,
        keptLocal: false,
        note: 'a tombstone exists for this slug (previously unshared); refusing to re-publish. Use /team-memory to manage tombstones.',
      })
      continue
    }

    // Provenance backstop: never re-publish a team-origin file. If the bytes the
    // skill staged carry metadata.origin === "team", skip it.
    if (existsSync(targetPath)) {
      const mem = readMemory(targetPath)
      if (mem.metadata.origin === 'team') {
        perSlug.push({
          slug,
          accepted: false,
          inCheckout: true,
          linked: false,
          keptLocal: false,
          note: 'frontmatter metadata.origin == team (team-provenance); skipped (not re-published)',
        })
        continue
      }
    }

    accepted.push({ slug, targetPath })
  }

  // Nothing accepted -> a successful no-op (skill found nothing publishable).
  if (accepted.length === 0) {
    return {
      published: true,
      pushed: false,
      committed: false,
      reason:
        perSlug.length > 0
          ? 'no publishable slugs (all invalid / tombstoned / team-origin)'
          : 'no slugs to publish (no-op)',
      commit: '',
      slugs: perSlug,
    }
  }

  // --- Stage ONLY the accepted, existing paths (exact path args) ---
  ensureIdentity(checkoutDir)

  const stagedPathspecs: string[] = []
  for (const acc of accepted) {
    if (!existsSync(acc.targetPath)) {
      // The skill said it wrote this slug but it isn't there — nothing to stage.
      continue
    }
    stageExact(checkoutDir, acc.targetPath)
    stagedPathspecs.push(acc.targetPath)
  }

  // Is anything actually staged for OUR pathspecs vs HEAD? `git add` of a file
  // byte-identical to its tracked HEAD copy stages nothing, while a new/changed
  // file does — so this single scoped check authoritatively distinguishes a
  // byte-identical dedupe no-op from a real change. Scoping to our pathspecs
  // means an unrelated already-staged file can't force a spurious commit. (On a
  // repo with no commits, `diff --cached` lists staged additions as changes, so
  // a genuine first publish is correctly detected.)
  const stagedDiffers =
    stagedPathspecs.length > 0 &&
    git(['diff', '--cached', '--quiet', '--', ...stagedPathspecs], { cwd: checkoutDir }).status !== 0

  const committedSha = (): string => {
    const r = git(['rev-parse', 'HEAD'], { cwd: checkoutDir })
    return r.status === 0 ? r.stdout.trim() : ''
  }
  const pushOpts = opts.retries && opts.retries > 0 ? { retries: opts.retries } : {}

  if (!stagedDiffers) {
    // Nothing changed vs HEAD -> every accepted slug was byte-identical (dedupe,
    // DESIGN §8.1). But a PRIOR run may have committed locally and FAILED to push;
    // a byte-identical rerun must still LAND that pending commit, not report a
    // local-only state as published. Flush any unpushed commits first.
    if (hasUnpushedCommits(checkoutDir)) {
      const outcome = pushWithRebase(checkoutDir, pushOpts)
      if (!outcome.ok) {
        const kept = accepted.map((a) =>
          keptLocalResult(
            a,
            outcome.conflict
              ? 'a prior commit is unpushed and a rebase conflict blocks it; Claude must merge then re-run'
              : 'a prior commit is unpushed and the push failed; re-run to retry (nothing lost)',
          ),
        )
        return {
          published: false,
          pushed: false,
          committed: false,
          reason: `local commit(s) not yet on the remote; push pending: ${outcome.reason}`,
          commit: committedSha(),
          slugs: [...perSlug, ...kept],
        }
      }
      const linked = linkBackPushed(accepted, nativeDir)
      return {
        published: true,
        pushed: true,
        committed: false,
        reason: 'no new changes; flushed a pending local commit to the remote',
        commit: committedSha(),
        slugs: [...perSlug, ...linked],
      }
    }
    // No staged change AND no pending commit. If NONE of the named slugs were
    // actually present in the checkout (stagedPathspecs empty), nothing was
    // published — report that honestly instead of a misleading published:true.
    // If at least one WAS present (byte-identical), it is genuinely already on the
    // remote: a clean dedupe no-op.
    const linked = linkBackPushed(accepted, nativeDir)
    if (stagedPathspecs.length === 0) {
      return {
        published: false,
        pushed: false,
        committed: false,
        reason: 'none of the named slugs were present in the checkout target; nothing published',
        commit: committedSha(),
        slugs: [...perSlug, ...linked],
      }
    }
    return {
      published: true,
      pushed: false,
      committed: false,
      reason: 'all named slugs byte-identical and already on the remote (no-op)',
      commit: committedSha(),
      slugs: [...perSlug, ...linked],
    }
  }

  // --- Commit ONLY the staged slug pathspecs (never a pathspec-less commit) ---
  const commit = git(['commit', '-m', message, '--', ...stagedPathspecs], { cwd: checkoutDir })
  if (commit.status !== 0) {
    const kept = accepted.map((a) => keptLocalResult(a, 'commit failed; local real file kept'))
    return {
      published: false,
      pushed: false,
      committed: false,
      reason: `git commit failed; local real files kept: ${commit.stderr.trim() || commit.stdout.trim()}`,
      commit: '',
      slugs: [...perSlug, ...kept],
    }
  }
  // --- Land the commit via the SHARED helper (pull --rebase -> push, retry) ---
  const outcome = pushWithRebase(checkoutDir, pushOpts)

  if (!outcome.ok) {
    const sha = committedSha()
    const kept = accepted.map((a) =>
      keptLocalResult(
        a,
        outcome.conflict
          ? 'rebase conflict; local real file kept (commit is local-only; Claude must merge both sides then re-run)'
          : 'push failed; local real file kept (commit is local-only; re-run to retry)',
      ),
    )
    return {
      published: false,
      pushed: false,
      committed: true,
      reason: outcome.conflict
        ? `a teammate change conflicts with this commit; ${outcome.reason}. Claude must merge both sides (DESIGN §9) then re-run /share-memory. Local files kept; commit ${sha} is local-only.`
        : `committed locally but ${outcome.reason}; local real files kept; commit ${sha} is local-only (re-run /share-memory to retry; never force-push)`,
      commit: sha,
      slugs: [...perSlug, ...kept],
    }
  }

  // --- Success: link native real files to the pushed copies (only if identical) ---
  const sha = committedSha()
  const linked = linkBackPushed(accepted, nativeDir)
  ctmLog(`publish: ${outcome.reason}`)
  return {
    published: true,
    pushed: true,
    committed: true,
    reason: `${outcome.reason}; commit ${sha}`,
    commit: sha,
    slugs: [...perSlug, ...linked],
  }
}
