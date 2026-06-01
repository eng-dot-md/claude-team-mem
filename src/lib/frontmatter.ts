// Minimal YAML-frontmatter parser tailored to memory files. We deliberately do
// NOT pull in a YAML dependency (zero-runtime-dep build): memory frontmatter is a
// flat set of `key: value` scalars plus a single nested `metadata:` block.
//
// Block rules (per spec): the frontmatter is ONLY a leading `---` ... `---` block.
// The FIRST line that is exactly `---` at column 0 closes it, so `---` appearing
// inside the body is safe. Scalar values have surrounding single/double quotes
// stripped. The `metadata:` block (indented `key: value` lines) parses into an
// object of string values.

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import type { Memory } from '../types'
import { ctmLog } from './log'

/** Parsed frontmatter: top-level `data` (incl. a nested `metadata` object) + the body. */
export interface Frontmatter {
  data: Record<string, unknown>
  body: string
}

/** Strip one matching pair of surrounding single or double quotes from a scalar. */
function unquote(v: string): string {
  const s = v.trim()
  if (s.length >= 2) {
    const first = s[0]
    const last = s[s.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1)
    }
  }
  return s
}

/** Leading-whitespace count (spaces/tabs) of a line. */
function indentOf(line: string): number {
  let n = 0
  while (n < line.length && (line[n] === ' ' || line[n] === '\t')) n++
  return n
}

/**
 * Parse the leading frontmatter block of `content`. If the content does not start
 * with a `---` line, returns `{ data: {}, body: content }` (no frontmatter).
 * Never throws.
 */
export function parseFrontmatter(content: string): Frontmatter {
  // Strip a leading UTF-8 BOM and normalize CRLF so column-0 `---` detection is
  // reliable — an editor-inserted BOM would otherwise make the opening `---` fail
  // to match and the whole frontmatter block be mis-read as body (losing
  // metadata.scope/origin and the name/description used downstream).
  const text = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const lines = text.split('\n')

  // Must open with a column-0 `---`.
  if (lines.length === 0 || lines[0] !== '---') {
    return { data: {}, body: content }
  }

  // Find the FIRST closing `---` at column 0 after the opener.
  let close = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i
      break
    }
  }
  if (close === -1) {
    // Unterminated frontmatter -> treat as no frontmatter (fail-soft).
    return { data: {}, body: content }
  }

  const fmLines = lines.slice(1, close)
  const body = lines.slice(close + 1).join('\n')

  const data: Record<string, unknown> = {}
  let i = 0
  while (i < fmLines.length) {
    const line = fmLines[i] ?? ''
    i++
    if (line.trim().length === 0) continue
    // Only handle top-level (unindented) keys here; nested handled per-block below.
    if (indentOf(line) > 0) continue

    const colon = line.indexOf(':')
    if (colon < 0) continue
    const key = line.slice(0, colon).trim()
    const rest = line.slice(colon + 1)
    if (key.length === 0) continue

    if (rest.trim().length === 0) {
      // A block key (e.g. `metadata:`). Consume following more-indented lines as
      // a flat string map. Non-`key: value` indented lines are skipped.
      const block: Record<string, string> = {}
      let sawChild = false
      while (i < fmLines.length) {
        const child = fmLines[i] ?? ''
        if (child.trim().length === 0) {
          i++
          continue
        }
        if (indentOf(child) === 0) break // back to top level
        i++
        const c = child.indexOf(':')
        if (c < 0) continue
        const ck = child.slice(0, c).trim()
        const cv = unquote(child.slice(c + 1))
        if (ck.length > 0) {
          block[ck] = cv
          sawChild = true
        }
      }
      // Record as an object (even if empty) so `metadata` is always an object.
      data[key] = sawChild ? block : {}
    } else {
      data[key] = unquote(rest)
    }
  }

  return { data, body }
}

/** Coerce a parsed frontmatter `metadata` value into a string->string record. */
function metadataRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v
      else if (typeof v === 'number' || typeof v === 'boolean') out[k] = String(v)
    }
  }
  return out
}

/**
 * Read a memory file from disk into a {@link Memory}. Fail-soft: an unreadable
 * file yields a Memory with just the slug and empty metadata/body.
 */
export function readMemory(file: string): Memory {
  const slug = basename(file)
  try {
    const content = readFileSync(file, 'utf8')
    const { data, body } = parseFrontmatter(content)
    const name = typeof data.name === 'string' ? data.name : undefined
    const description = typeof data.description === 'string' ? data.description : undefined
    return {
      slug,
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
      metadata: metadataRecord(data.metadata),
      body,
    }
  } catch (err) {
    ctmLog(`readMemory failed for ${file}: ${String(err)}`)
    return { slug, metadata: {} }
  }
}

/**
 * Validate a slug supplied by a skill (publish/unshare). Rules:
 *  - reject empty / `.` / `..`
 *  - reject a leading `/` (absolute)
 *  - reject any path separator (`/` or `\`)
 *  - reject a `..` PATH COMPONENT
 *  - ALLOW internal dots and dotted names (`api.v2.notes.md`, `.env-notes.md`)
 * Never throws.
 */
export function isValidSlug(slug: string | undefined | null): boolean {
  if (!slug) return false
  const s = slug
  if (s.length === 0) return false
  if (s === '.' || s === '..') return false
  if (s.startsWith('/')) return false
  if (s.includes('/') || s.includes('\\')) return false
  if (s.includes('\0')) return false
  // No `..` as a standalone path component (there are no separators here, so the
  // whole string is one component; the `s === '..'` check above already covers it,
  // but keep an explicit segment guard for clarity / future-proofing).
  if (s.split(/[/\\]/).some((seg) => seg === '..')) return false
  return true
}
