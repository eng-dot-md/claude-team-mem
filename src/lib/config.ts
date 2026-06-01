// Config read/write at <dataDir>/config.json. Reads are fail-soft (a missing or
// corrupt file yields safe defaults, never a throw).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Config } from '../types'
import { configPath } from './paths'
import { ctmLog } from './log'

/** Default index byte cap when config omits `maxIndexBytes`. */
export const DEFAULT_MAX_INDEX_BYTES = 20_000

/** A safe empty config. */
function defaultConfig(): Config {
  return { owners: {}, maxIndexBytes: DEFAULT_MAX_INDEX_BYTES }
}

/**
 * Read and validate the config. Always returns a usable Config: a missing file,
 * unreadable file, invalid JSON, or wrong shape all degrade to defaults. Only
 * string->string entries in `owners` are kept; `maxIndexBytes` is honored only
 * when it's a non-negative finite number (0 = uncapped, preserved).
 */
export function readConfig(): Config {
  try {
    const path = configPath()
    if (!existsSync(path)) return defaultConfig()
    const raw = readFileSync(path, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return defaultConfig()

    const obj = parsed as Record<string, unknown>
    const owners: Record<string, string> = {}
    if (typeof obj.owners === 'object' && obj.owners !== null) {
      for (const [k, v] of Object.entries(obj.owners as Record<string, unknown>)) {
        if (typeof v === 'string' && v.length > 0) owners[k] = v
      }
    }

    const cfg: Config = { owners }
    if (typeof obj.maxIndexBytes === 'number' && Number.isFinite(obj.maxIndexBytes) && obj.maxIndexBytes >= 0) {
      cfg.maxIndexBytes = obj.maxIndexBytes
    } else {
      cfg.maxIndexBytes = DEFAULT_MAX_INDEX_BYTES
    }
    return cfg
  } catch (err) {
    ctmLog(`readConfig failed, using defaults: ${String(err)}`)
    return defaultConfig()
  }
}

/**
 * Write the config (pretty-printed), creating the data dir if needed. Returns
 * true on success, false on failure (never throws).
 */
export function writeConfig(c: Config): boolean {
  try {
    const path = configPath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(c, null, 2) + '\n', 'utf8')
    return true
  } catch (err) {
    ctmLog(`writeConfig failed: ${String(err)}`)
    return false
  }
}

/** Look up the storage spec configured for `owner` ("auto" | "owner/repo" | URL), or null. */
export function ownerMapping(config: Config, owner: string | undefined | null): string | null {
  if (!owner) return null
  const v = config.owners[owner]
  return v && v.length > 0 ? v : null
}
