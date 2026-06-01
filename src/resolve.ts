// Top-level resolution: given a project root, decide whether team-memory is
// enabled and, if so, produce all the paths the load/publish/unshare flows need.
//
// Order (DESIGN §3):
//   1. env CLAUDE_TEAM_MEMORY_REPO override (full URL or owner/repo)
//   2. config `owners` lookup by the project's origin owner
//        ("auto" | "owner/repo" | full URL)
//   3. else disabled
// Then the anti-circular guard. When enabled, ensure the checkout exists
// (cloneOnce; we do NOT pull here — load refreshes in the background).

import type { Resolution } from './types'
import { git, cloneOnce } from './lib/git'
import { parseRemote, autoStorageUrl } from './lib/remote'
import {
  dataDir,
  checkoutDirFromUrl,
  projectKey,
  nativeMemoryDir,
} from './lib/paths'
import { readConfig, ownerMapping } from './lib/config'
import { isCircular } from './lib/guard'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ctmLog } from './lib/log'

/** Read the `origin` remote URL of the git repo at `projectRoot`, or null. */
export function projectOrigin(projectRoot: string): string | null {
  const r = git(['config', '--get', 'remote.origin.url'], { cwd: projectRoot })
  if (r.status !== 0) return null
  const url = r.stdout.trim()
  return url.length > 0 ? url : null
}

/**
 * Turn a storage spec into a concrete git URL given the project's origin.
 *  - "auto"            -> <host>:<owner>/claude-team-memory (origin's protocol)
 *  - "owner/repo"      -> same host/protocol as origin, that owner/repo
 *  - a full git URL    -> used verbatim (must parse)
 * Returns null if it can't be resolved.
 */
export function specToStorageUrl(
  spec: string,
  origin: string | null,
  owner: string | null,
): string | null {
  const s = spec.trim()
  if (s.length === 0) return null

  if (s === 'auto') {
    return owner ? autoStorageUrl(origin, owner) : null
  }

  // A full URL parses directly.
  if (parseRemote(s)) return s

  // Bare `owner/repo` (exactly one slash, no scheme/colon) -> graft onto origin's host.
  if (/^[^/\s:]+\/[^/\s:]+$/.test(s)) {
    const [graftOwner, graftRepo] = s.split('/') as [string, string]
    if (origin) {
      const auto = autoStorageUrl(origin, graftOwner)
      if (auto) return auto.replace(/claude-team-memory\.git$/, `${graftRepo}.git`)
    }
    return null
  }

  return null
}

/** A disabled resolution carrying just a reason. */
function disabled(reason: string): Resolution {
  return { enabled: false, reason }
}

/**
 * Resolve team-memory for `projectRoot`. Never throws; on any internal failure
 * returns a disabled Resolution with an explanatory reason.
 */
export function resolve(projectRoot: string): Resolution {
  try {
    const origin = projectOrigin(projectRoot)
    const originParsed = parseRemote(origin)
    const projectOwner = originParsed?.owner ?? null

    // 1. Env override.
    let storageUrl: string | null = null
    let reason = ''
    const envSpec = process.env.CLAUDE_TEAM_MEMORY_REPO
    if (envSpec && envSpec.trim().length > 0) {
      storageUrl = specToStorageUrl(envSpec.trim(), origin, projectOwner)
      if (!storageUrl) return disabled(`env CLAUDE_TEAM_MEMORY_REPO is set but unparseable: ${envSpec}`)
      reason = `env CLAUDE_TEAM_MEMORY_REPO -> ${storageUrl}`
    } else {
      // 2. Config lookup by the project's owner.
      if (!projectOwner) return disabled('project has no parseable origin owner')
      const config = readConfig()
      const spec = ownerMapping(config, projectOwner)
      if (!spec) return disabled(`no config mapping for owner "${projectOwner}"`)
      storageUrl = specToStorageUrl(spec, origin, projectOwner)
      if (!storageUrl) return disabled(`config mapping for "${projectOwner}" is unparseable: ${spec}`)
      reason = `owner "${projectOwner}" -> ${spec}`
    }

    // 3. Anti-circular guard.
    if (isCircular(storageUrl, origin, projectRoot, dataDir())) {
      return disabled(`anti-circular guard: storage repo == project origin or cwd inside a checkout`)
    }

    // Derive paths.
    const checkoutDir = checkoutDirFromUrl(storageUrl)
    const key = projectKey(origin)
    if (!checkoutDir || !key) {
      return disabled(`could not derive checkout/key (storageUrl=${storageUrl}, origin=${origin})`)
    }
    const targetMemoryDir = join(checkoutDir, key, 'memory')
    const nativeDir = nativeMemoryDir(projectRoot)

    // Ensure the checkout exists (clone once; do NOT pull here).
    const cloned = cloneOnce(storageUrl, checkoutDir)
    if (cloned.status !== 0 && !existsSync(join(checkoutDir, '.git'))) {
      // No usable checkout (first-run clone failed: offline / auth / bad URL). Degrade
      // to DISABLED for this session rather than reporting enabled with a missing
      // checkout (which would silently inject nothing and hide the failure). The next
      // session retries the clone.
      ctmLog(`resolve: clone failed and no usable checkout exists: ${cloned.stderr.trim()}`)
      return disabled(`storage checkout unavailable (clone failed): ${cloned.stderr.trim() || 'unknown error'}`)
    }

    return {
      enabled: true,
      reason,
      storageUrl,
      checkoutDir,
      projectKey: key,
      targetMemoryDir,
      nativeMemoryDir: nativeDir,
    }
  } catch (err) {
    return disabled(`resolve failed: ${String(err)}`)
  }
}
