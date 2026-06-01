// SessionStart load path (DESIGN §4, §6, §9).
//
// buildSessionContext(projectRoot):
//   1. resolve() — if disabled, return {context:null} (no-op).
//   2. Kick off a DETACHED background `git pull --ff-only` of the checkout. Never
//      awaited; must not block startup (this session uses the last synced copy,
//      the next sees the update).
//   3. Reconcile THIS project's symlinks in the native dir against the checkout's
//      team files: create ABSOLUTE symlinks into the checkout, idempotently; prune
//      ONLY dangling symlinks that resolve INTO the checkout; NEVER touch real
//      files. Track a real-vs-team clash (a native REAL file shadowing a team
//      slug) and an unrelated-symlink clash (a native symlink to OUTSIDE the
//      checkout sharing a team slug) separately.
//   4. Derive a fresh index from each team file's frontmatter (name/description;
//      fall back to first `#` heading / slug) as `- [Title](slug.md) — hook`,
//      honoring config.maxIndexBytes (Buffer.byteLength, cap at line boundaries,
//      always keep >=1 entry, append an "N more" note when truncated).
//   5. Compose: preamble + index + any clash sections.
//
// If the native dir is unusable, skip symlinking but still return the index
// (graceful degrade). Everything is fail-soft; this never throws.

import { spawn } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs'
import { isAbsolute, join, resolve as resolvePath } from 'node:path'
import { resolve } from './resolve'
import { ensureNativeDir, pathInside } from './lib/paths'
import { readConfig, DEFAULT_MAX_INDEX_BYTES } from './lib/config'
import { readMemory } from './lib/frontmatter'
import { ctmLog } from './lib/log'
import type { Resolution } from './types'

// Hard ceiling on the COMPOSED additionalContext, independent of maxIndexBytes
// (which bounds only the index body). The SessionStart hook's stdout is a pipe
// (~64 KiB kernel buffer); if the JSON-encoded payload exceeds that on a single
// synchronous write it can still be delivered, but we keep a comfortable margin
// so the whole object — preamble + index + clash sections + JSON wrapper, and the
// extra bytes JSON-string-escaping adds — stays well under the buffer. This is a
// last-resort backstop: maxIndexBytes (default 20000) is the normal bound. The
// payload is measured AFTER JSON.stringify (escaping included) elsewhere; this
// caps the raw context string at a safe size first.
const MAX_CONTEXT_BYTES = 48_000

/** Max clash bullets rendered per clash section (the rest collapse into a count). */
const MAX_CLASH_LINES = 50

/** A team file discovered in the checkout, with its derived index title. */
interface TeamEntry {
  /** Filename incl. extension, e.g. `foo.md`. */
  slug: string
  /** Absolute path to the real bytes in the checkout. */
  target: string
  /** Human title for the index (name -> first `#` heading -> slug). */
  title: string
}

/** Result of the symlink reconcile pass. */
interface ReconcileResult {
  /** Slugs where a native REAL file shadows a team file (do not overwrite). */
  realClashes: string[]
  /** Slugs where a native symlink points OUTSIDE this checkout (unrelated). */
  unrelatedSymlinkClashes: string[]
}

/** Only `.md` files are memory files. */
function isMemoryFile(name: string): boolean {
  return name.endsWith('.md')
}

/**
 * Enumerate the team files physically present in `targetMemoryDir`. Skips the
 * `.tombstones` dir and any non-`.md` entries. Fail-soft (returns [] on error).
 */
function listTeamFiles(targetMemoryDir: string): string[] {
  try {
    if (!existsSync(targetMemoryDir)) return []
    return readdirSync(targetMemoryDir, { withFileTypes: true })
      .filter((d) => (d.isFile() || d.isSymbolicLink()) && isMemoryFile(d.name))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b))
  } catch (err) {
    ctmLog(`listTeamFiles failed for ${targetMemoryDir}: ${String(err)}`)
    return []
  }
}

/**
 * Derive an index title for a team file: frontmatter `name`, else the first `#`
 * heading in the body, else the slug. Description is appended by the caller as
 * the trailing ` — hook` context; here we only compute the bracket title.
 */
function deriveTitle(file: string, slug: string): string {
  const mem = readMemory(file)
  if (mem.name && mem.name.trim().length > 0) return mem.name.trim()
  const body = mem.body ?? ''
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    const m = line.match(/^#{1,6}\s+(.+)$/)
    if (m && m[1] && m[1].trim().length > 0) return m[1].trim()
  }
  return slug
}

/** Build the list of team entries (slug + target + derived title), index-ready. */
function collectTeamEntries(targetMemoryDir: string): TeamEntry[] {
  const out: TeamEntry[] = []
  for (const slug of listTeamFiles(targetMemoryDir)) {
    const target = join(targetMemoryDir, slug)
    out.push({ slug, target, title: deriveTitle(target, slug) })
  }
  return out
}

/**
 * Resolve a symlink's target to an absolute path WITHOUT requiring it to exist.
 * readlinkSync gives the raw (possibly relative) link text; relative targets are
 * resolved against the link's own directory. Returns null on error.
 */
function symlinkTargetAbs(linkPath: string): string | null {
  try {
    const raw = readlinkSync(linkPath)
    if (isAbsolute(raw)) return resolvePath(raw)
    return resolvePath(join(linkPath, '..'), raw)
  } catch {
    return null
  }
}

/**
 * Reconcile the native dir's symlinks against `entries` (the checkout's team
 * files). For each team slug we want an ABSOLUTE symlink `native/<slug>` -> the
 * checkout copy. Rules (DESIGN §6.3, §9):
 *  - Idempotent: if the link already resolves INTO this checkout at the right
 *    target, leave it; if it points elsewhere inside the checkout, repoint it.
 *  - A native REAL file (not a symlink) with a team slug = real-vs-team clash:
 *    surface it, NEVER overwrite.
 *  - A native SYMLINK pointing OUTSIDE this checkout with a team slug =
 *    unrelated-symlink clash: surface it (separate wording), NEVER overwrite.
 *  - Prune ONLY dangling symlinks that resolve INTO this checkout (their target
 *    no longer exists). Never remove a real file; never remove a symlink that
 *    points outside the checkout.
 * Never throws.
 */
function reconcile(
  nativeDir: string,
  checkoutDir: string,
  entries: TeamEntry[],
): ReconcileResult {
  const realClashes: string[] = []
  const unrelatedSymlinkClashes: string[] = []
  const wantedSlugs = new Set(entries.map((e) => e.slug))

  // Pass 1: ensure a correct symlink for each team file.
  for (const entry of entries) {
    const linkPath = join(nativeDir, entry.slug)
    try {
      const stat = lstatSync(linkPath, { throwIfNoEntry: false })
      if (!stat) {
        // Nothing there yet — create the absolute symlink into the checkout.
        symlinkSync(entry.target, linkPath)
        continue
      }
      if (stat.isSymbolicLink()) {
        const tgt = symlinkTargetAbs(linkPath)
        // Verify it resolves INTO this checkout before treating it as "ours".
        if (tgt && pathInside(tgt, checkoutDir)) {
          if (tgt === resolvePath(entry.target)) {
            // Already correct — idempotent no-op (do not thrash).
            continue
          }
          // Points into the checkout but at the wrong file — repoint it.
          unlinkSync(linkPath)
          symlinkSync(entry.target, linkPath)
          continue
        }
        // Symlink pointing OUTSIDE this checkout that shadows a team slug:
        // unrelated-symlink clash. Surface, never overwrite.
        unrelatedSymlinkClashes.push(entry.slug)
        continue
      }
      // A real file (or dir) shadowing a team slug: real-vs-team clash.
      realClashes.push(entry.slug)
    } catch (err) {
      ctmLog(`reconcile: failed on ${linkPath}: ${String(err)}`)
    }
  }

  // Pass 2: prune ONLY dangling symlinks that resolve INTO this checkout and are
  // no longer wanted. Never touch real files; never touch out-of-checkout links.
  try {
    if (existsSync(nativeDir)) {
      for (const dirent of readdirSync(nativeDir, { withFileTypes: true })) {
        if (!dirent.isSymbolicLink()) continue
        const name = dirent.name
        const linkPath = join(nativeDir, name)
        const tgt = symlinkTargetAbs(linkPath)
        if (!tgt || !pathInside(tgt, checkoutDir)) continue // not ours / unrelated
        // It points into our checkout. Prune it only if it's dangling (target
        // gone) AND it's not a team file we just (re)linked.
        const dangling = !existsSync(tgt)
        if (dangling && !wantedSlugs.has(name)) {
          try {
            unlinkSync(linkPath)
          } catch (err) {
            ctmLog(`reconcile: prune failed on ${linkPath}: ${String(err)}`)
          }
        }
      }
    }
  } catch (err) {
    ctmLog(`reconcile prune pass failed for ${nativeDir}: ${String(err)}`)
  }

  return { realClashes, unrelatedSymlinkClashes }
}

/**
 * Build the index line for one team entry: `- [Title](slug.md) — hook`, where the
 * trailing context is the file's `description` when present, else a generic hook.
 */
function indexLine(entry: TeamEntry): string {
  const mem = readMemory(entry.target)
  const hook =
    mem.description && mem.description.trim().length > 0
      ? mem.description.trim()
      : 'team-shared memory'
  return `- [${entry.title}](${entry.slug}) — ${hook}`
}

/**
 * Assemble the index body honoring `maxIndexBytes` (DESIGN §6.4):
 *  - measure with Buffer.byteLength (exact UTF-8 bytes);
 *  - cap at LINE boundaries (never split a line);
 *  - ALWAYS keep at least one entry even if it alone exceeds the cap;
 *  - when truncated, append an `…and N more` note.
 * `maxIndexBytes === 0` means uncapped.
 */
function buildIndexBody(entries: TeamEntry[], maxIndexBytes: number): string {
  const lines = entries.map(indexLine)
  if (lines.length === 0) return ''

  // Uncapped (0) or no positive finite cap -> everything.
  if (!(maxIndexBytes > 0)) return lines.join('\n')

  const kept: string[] = []
  let bytes = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    // Account for the newline that joins this line to the previous one.
    const add = Buffer.byteLength(line, 'utf8') + (kept.length > 0 ? 1 : 0)
    if (kept.length >= 1 && bytes + add > maxIndexBytes) break
    kept.push(line)
    bytes += add
  }

  if (kept.length < lines.length) {
    const remaining = lines.length - kept.length
    kept.push(`…and ${remaining} more (see the team memory checkout).`)
  }
  return kept.join('\n')
}

/** The fixed preamble (DESIGN §6.4 / §9): how Claude should treat team memory. */
function preamble(): string {
  return [
    'Team-shared memory (synced from your team\'s private storage repo):',
    '- These facts are shared with your team; treat them as reference, not personal notes.',
    '- Do NOT re-save them into local memory and do NOT re-share them (they are already shared).',
    '- Verify a fact against the current code/state before relying on it.',
    '- On conflict with something local, prefer the newer and more specific fact, and flag it.',
  ].join('\n')
}

/** Cap a list of clash slugs to at most `max` bullet lines, appending a count note. */
function clashBullets(slugs: string[], max: number): string[] {
  const shown = slugs.slice(0, max).map((s) => `- ${s}`)
  if (slugs.length > max) shown.push(`- …and ${slugs.length - max} more.`)
  return shown
}

/**
 * Render the optional clash sections appended after the index. Each list is capped
 * (DESIGN fail-soft) so a pathological native dir with hundreds of clashing names
 * cannot, by itself, blow the SessionStart context past the OS pipe buffer.
 */
function clashSections(rc: ReconcileResult): string[] {
  const sections: string[] = []
  if (rc.realClashes.length > 0) {
    sections.push(
      [
        'Name clashes (local real file vs. team file with the same name) — reconcile, do not blindly overwrite:',
        ...clashBullets(rc.realClashes, MAX_CLASH_LINES),
      ].join('\n'),
    )
  }
  if (rc.unrelatedSymlinkClashes.length > 0) {
    sections.push(
      [
        'Unrelated symlinks shadowing a team file name (a local symlink points outside the team checkout) — resolve manually:',
        ...clashBullets(rc.unrelatedSymlinkClashes, MAX_CLASH_LINES),
      ].join('\n'),
    )
  }
  return sections
}

/**
 * Hard-cap the composed context at `MAX_CONTEXT_BYTES`, truncating at LINE
 * boundaries (never mid-line, so the injected text stays well-formed) and
 * appending a one-line truncation note. The preamble is the first block and is
 * always kept whole. This is the final safety net on top of maxIndexBytes; it
 * guarantees the SessionStart payload can never balloon past the pipe buffer
 * regardless of config (`maxIndexBytes: 0`) or native-dir clutter.
 */
function capContext(context: string): string {
  if (Buffer.byteLength(context, 'utf8') <= MAX_CONTEXT_BYTES) return context

  const note = '\n\n[team-memory: context truncated to fit the session-start budget.]'
  const noteBytes = Buffer.byteLength(note, 'utf8')
  const budget = Math.max(0, MAX_CONTEXT_BYTES - noteBytes)

  const lines = context.split('\n')
  const kept: string[] = []
  let bytes = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    const add = Buffer.byteLength(line, 'utf8') + (kept.length > 0 ? 1 : 0)
    if (kept.length >= 1 && bytes + add > budget) break
    kept.push(line)
    bytes += add
  }
  return kept.join('\n') + note
}

/**
 * Build the SessionStart additionalContext for `projectRoot`, or `{context:null}`
 * when there is nothing to inject (disabled, or no team files and no clashes).
 * Never throws.
 */
export function buildSessionContext(projectRoot: string): { context: string | null } {
  try {
    const res: Resolution = resolve(projectRoot)
    if (!res.enabled) {
      ctmLog(`load: disabled (${res.reason})`)
      return { context: null }
    }

    const checkoutDir = res.checkoutDir
    const targetMemoryDir = res.targetMemoryDir
    if (!checkoutDir || !targetMemoryDir) {
      ctmLog('load: enabled but missing checkout/target paths; skipping')
      return { context: null }
    }

    // 2. Background refresh — detached, never awaited, must not block startup.
    backgroundPull(checkoutDir)

    // 4 (gather). Collect the team files first; needed for both reconcile + index.
    const entries = collectTeamEntries(targetMemoryDir)

    // 3. Reconcile symlinks (graceful degrade if the native dir is unusable).
    let rc: ReconcileResult = { realClashes: [], unrelatedSymlinkClashes: [] }
    const nativeDir = ensureNativeDir(projectRoot)
    if (nativeDir) {
      rc = reconcile(nativeDir, checkoutDir, entries)
    } else {
      ctmLog('load: native dir unusable; injecting index only (no symlinking)')
    }

    // Nothing to share and nothing to flag -> inject nothing.
    if (entries.length === 0 && rc.realClashes.length === 0 && rc.unrelatedSymlinkClashes.length === 0) {
      return { context: null }
    }

    // 4 (render) + 5 (compose).
    const config = readConfig()
    const maxIndexBytes =
      typeof config.maxIndexBytes === 'number' ? config.maxIndexBytes : DEFAULT_MAX_INDEX_BYTES

    const parts: string[] = [preamble()]
    if (entries.length > 0) {
      const body = buildIndexBody(entries, maxIndexBytes)
      if (body.length > 0) {
        parts.push(['Available team memory:', body].join('\n'))
      }
    }
    parts.push(...clashSections(rc))

    // Final backstop: bound the WHOLE composed context, not just the index body,
    // so an uncapped/cluttered project can never emit an oversized payload that a
    // synchronous stdout write would still have to push through the pipe.
    return { context: capContext(parts.join('\n\n')) }
  } catch (err) {
    // Absolute backstop: load must never throw.
    ctmLog(`buildSessionContext failed: ${String(err)}`)
    return { context: null }
  }
}

/**
 * Spawn a DETACHED, unref'd `git pull --ff-only` in the checkout. We do not await
 * it and do not read its output; failures are irrelevant to this session (the
 * synchronous clone in resolve() already guarantees a usable checkout). Wrapped
 * so a spawn failure can never break the hook.
 */
function backgroundPull(checkoutDir: string): void {
  try {
    // Only attempt if the checkout is a real dir (resolve() clones it; guard anyway).
    if (!existsSync(checkoutDir)) return
    const child = spawn('git', ['pull', '--ff-only'], {
      cwd: checkoutDir,
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_SSH_COMMAND:
          process.env.GIT_SSH_COMMAND ?? 'ssh -oBatchMode=yes -oStrictHostKeyChecking=accept-new',
      },
    })
    child.on('error', () => {
      /* swallow: background refresh is best-effort */
    })
    child.unref()
  } catch (err) {
    ctmLog(`backgroundPull failed to spawn: ${String(err)}`)
  }
}

// Re-export the leaf helpers so tests can exercise the pure index/reconcile logic
// without going through git or the resolve() flow. Not part of the public contract
// beyond buildSessionContext, but safe to import.
export const __internals = {
  deriveTitle,
  buildIndexBody,
  reconcile,
  preamble,
  collectTeamEntries,
  capContext,
  clashSections,
  MAX_CONTEXT_BYTES,
  MAX_CLASH_LINES,
}
