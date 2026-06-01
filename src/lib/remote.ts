// Git remote URL parsing + storage-URL helpers. All fail-soft (return null/false
// rather than throwing). The golden rule for parsing: strip a trailing slash and
// a trailing `.git` BEFORE splitting host from path, then split path into
// owner(+nested groups) and repo — never silently drop middle path segments.

import type { ParsedRemote } from '../types'

/** Strip one trailing `/` then one trailing `.git` (in that order). */
function stripTail(s: string): string {
  let out = s
  while (out.endsWith('/')) out = out.slice(0, -1)
  if (out.endsWith('.git')) out = out.slice(0, -4)
  while (out.endsWith('/')) out = out.slice(0, -1)
  return out
}

/**
 * Split a cleaned `host` + `path` into ParsedRemote. `path` is everything after
 * the host (no leading slash). For nested forges (e.g. gitlab `group/sub/repo`)
 * the full nested prefix is preserved as `owner` and only the LAST segment is
 * `repo`. Returns null if there is no owner or no repo.
 */
function fromHostPath(host: string, path: string): ParsedRemote | null {
  const cleanHost = host.trim()
  const segments = path.split('/').filter((s) => s.length > 0)
  if (cleanHost.length === 0 || segments.length < 2) return null
  const repo = segments[segments.length - 1]
  const owner = segments.slice(0, -1).join('/')
  if (!repo || owner.length === 0) return null
  return { host: cleanHost, owner, repo }
}

/**
 * Parse a git remote URL into { host, owner, repo }. Handles:
 *  - scp-like:   git@host:owner/repo(.git)
 *  - https:      https://host/owner/repo(.git)(/)
 *  - ssh://:     ssh://git@host/owner/repo(.git)
 *  - git://, http:// likewise.
 * Nested group paths (gitlab) are preserved in `owner`. Returns null on anything
 * unrecognizable. Never throws.
 */
export function parseRemote(url: string | undefined | null): ParsedRemote | null {
  if (!url) return null
  const trimmed = url.trim()
  if (trimmed.length === 0) return null

  // scheme://[user@]host[:port]/path  — covers ssh, https, http, git, ftp, etc.
  const schemeMatch = trimmed.match(/^([a-z][a-z0-9+.-]*):\/\/(.+)$/i)
  if (schemeMatch) {
    const rest = schemeMatch[2] ?? ''
    const slash = rest.indexOf('/')
    if (slash < 0) return null
    let authority = rest.slice(0, slash)
    const path = stripTail(rest.slice(slash + 1))
    // Drop optional user@ and :port from the authority to get the bare host.
    const at = authority.lastIndexOf('@')
    if (at >= 0) authority = authority.slice(at + 1)
    const colon = authority.indexOf(':')
    const host = colon >= 0 ? authority.slice(0, colon) : authority
    return fromHostPath(host, path)
  }

  // scp-like: [user@]host:owner/repo(.git)  (no scheme, single ':' before path).
  // Distinguish from a Windows path / scheme by requiring a non-empty host and path.
  const scpMatch = trimmed.match(/^([^/@]+@)?([^/:]+):(.+)$/)
  if (scpMatch) {
    const host = scpMatch[2] ?? ''
    const path = stripTail(scpMatch[3] ?? '')
    // Reject if the "path" itself starts with `//` (that was really a scheme we missed).
    if (host.length > 0 && !path.startsWith('/')) {
      return fromHostPath(host, path)
    }
  }

  return null
}

/**
 * True if two git URLs point at the same repo, comparing after normalizing
 * trailing `/` and `.git`. Falls back to a normalized-string compare when either
 * side isn't a recognizable remote (so identical literal URLs still match).
 */
export function sameRepo(a: string | undefined | null, b: string | undefined | null): boolean {
  if (!a || !b) return false
  const pa = parseRemote(a)
  const pb = parseRemote(b)
  if (pa && pb) {
    return (
      pa.host.toLowerCase() === pb.host.toLowerCase() &&
      pa.owner === pb.owner &&
      pa.repo === pb.repo
    )
  }
  return stripTail(a.trim()) === stripTail(b.trim())
}

/**
 * Build the storage URL for the `"auto"` config value: same host + protocol as
 * the project's origin, owner replaced by the given `owner`, repo named
 * `claude-team-memory`. Returns null if `origin` can't be parsed.
 *
 * Protocol preservation:
 *  - scp-like origin  -> `git@<host>:<owner>/claude-team-memory.git`
 *  - scheme origin    -> `<scheme>://[user@]<host>[:port]/<owner>/claude-team-memory.git`
 */
export function autoStorageUrl(origin: string | undefined | null, owner: string): string | null {
  if (!origin || !owner) return null
  const trimmed = origin.trim()
  const repo = 'claude-team-memory'

  const schemeMatch = trimmed.match(/^([a-z][a-z0-9+.-]*):\/\/(.+)$/i)
  if (schemeMatch) {
    const scheme = schemeMatch[1] ?? ''
    const rest = schemeMatch[2] ?? ''
    const slash = rest.indexOf('/')
    if (slash < 0) return null
    const authority = rest.slice(0, slash) // keep user@ and :port verbatim
    return `${scheme}://${authority}/${owner}/${repo}.git`
  }

  const scpMatch = trimmed.match(/^([^/@]+@)?([^/:]+):(.+)$/)
  if (scpMatch) {
    const user = scpMatch[1] ?? 'git@'
    const host = scpMatch[2] ?? ''
    if (host.length === 0) return null
    return `${user}${host}:${owner}/${repo}.git`
  }

  return null
}
