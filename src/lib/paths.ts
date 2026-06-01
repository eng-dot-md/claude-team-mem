// Path derivation: data dir, config path, storage-repo checkout dir, and the
// native (Claude Code) per-project memory dir. All pure/fail-soft.

import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import type { ParsedRemote } from '../types'
import { parseRemote } from './remote'
import { ctmLog } from './log'

/**
 * The single data dir for both checkouts and config.
 * `CLAUDE_PLUGIN_DATA` is provided by Claude Code; default to `~/.claude-team-mem`.
 */
export function dataDir(): string {
  const env = process.env.CLAUDE_PLUGIN_DATA
  return env && env.length > 0 ? env : join(homedir(), '.claude-team-mem')
}

/** Canonical config location: `<dataDir>/config.json`. */
export function configPath(): string {
  return join(dataDir(), 'config.json')
}

/** The base dir Claude Code uses for native memory: `$CLAUDE_CONFIG_DIR` or `~/.claude`. */
export function claudeConfigDir(): string {
  const env = process.env.CLAUDE_CONFIG_DIR
  return env && env.length > 0 ? env : join(homedir(), '.claude')
}

/**
 * Derive the local checkout dir for a storage repo, keyed by the repo IDENTITY
 * (host__owner__repo) so different storage repos never share a checkout and
 * orgs mapped to the same repo do share one. Owner slashes (nested groups)
 * become `_` so the segment is a single safe dir name.
 * Returns null if the URL can't be parsed.
 */
export function checkoutDirFromUrl(url: string | undefined | null): string | null {
  const parsed = parseRemote(url)
  if (!parsed) return null
  return join(dataDir(), 'repos', projectKeyDirSegment(parsed))
}

/** `<host>__<owner>__<repo>` with owner slashes flattened to `_` (filesystem-safe). */
function projectKeyDirSegment(parsed: ParsedRemote): string {
  const owner = parsed.owner.replace(/\//g, '_')
  return `${parsed.host}__${owner}__${parsed.repo}`
}

/**
 * The project key = subtree inside the storage repo = `<owner>/<repo>`, preserving
 * nested group paths. This is the §3 `<org>/<repo>` key.
 */
export function projectKeyFromParsed(parsed: ParsedRemote | null): string | null {
  if (!parsed) return null
  return `${parsed.owner}/${parsed.repo}`
}

/** Convenience: parse a remote URL and return its `<owner>/<repo>` project key. */
export function projectKey(url: string | undefined | null): string | null {
  return projectKeyFromParsed(parseRemote(url))
}

/**
 * Derive Claude Code's native per-project memory dir (DESIGN §11.2):
 *   <base>/projects/<slug>/memory  where slug = absolutePath with every `/` and `.` -> `-`.
 * `projectRoot` is resolved to absolute first.
 */
export function nativeMemoryDir(projectRoot: string): string {
  const abs = resolve(projectRoot)
  return join(claudeConfigDir(), 'projects', slugForPath(abs), 'memory')
}

/** The native-dir slug for an absolute path: every `/` and `.` becomes `-`. */
export function slugForPath(path: string): string {
  return resolve(path).replace(/[/.]/g, '-')
}

/**
 * True if `child` is the same as, or nested inside, `parent` (both resolved to
 * absolute). Used for the anti-circular cwd-inside-checkout check and for the
 * "symlink resolves INTO the checkout" checks. Never throws.
 */
export function pathInside(child: string, parent: string): boolean {
  try {
    const c = resolve(child)
    const p = resolve(parent)
    if (c === p) return true
    const rel = relative(p, c)
    return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
  } catch {
    return false
  }
}

/**
 * Return the native memory dir ONLY if it is safe to use, else null.
 *
 * "Usable" means the project's `projects/<slug>/` parent already exists — Claude
 * Code creates that when it has memory for the project. We then ensure the
 * `memory/` leaf exists (creating just that leaf is fine). We deliberately do NOT
 * mkdir a bogus `projects/<slug>/` dir: if the slug derivation is wrong the
 * parent won't exist and we degrade gracefully (caller skips symlinking but can
 * still inject the index). This is the ONE owner of native-dir creation.
 */
export function ensureNativeDir(projectRoot: string): string | null {
  try {
    const memDir = nativeMemoryDir(projectRoot)
    const slugParent = join(memDir, '..') // projects/<slug>/
    if (!existsSync(slugParent)) {
      ctmLog(`native dir parent not found (derivation may be off): ${slugParent}`)
      return null
    }
    if (!existsSync(memDir)) {
      mkdirSync(memDir, { recursive: true })
    }
    return memDir
  } catch (err) {
    ctmLog(`ensureNativeDir failed: ${String(err)}`)
    return null
  }
}
