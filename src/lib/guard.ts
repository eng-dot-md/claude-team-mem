// Anti-circular guard (DESIGN §3 / §8.4). The plugin must never sync a storage
// repo into itself, and must never operate while we're working *inside* a
// plugin-data checkout (which would let the storage repo's own memory loop back).

import { join } from 'node:path'
import { sameRepo } from './remote'
import { pathInside } from './paths'

/**
 * True if syncing must be DISABLED for circular-safety:
 *  - the resolved storage URL is the same repo as the project's `origin`
 *    (compared after normalizing trailing slash/`.git`), OR
 *  - `cwd` is the same as, or inside, `<dataDir>/repos` (any storage checkout).
 * Never throws.
 */
export function isCircular(
  storageUrl: string | undefined | null,
  origin: string | undefined | null,
  cwd: string,
  dataDir: string,
): boolean {
  if (sameRepo(storageUrl, origin)) return true
  const reposRoot = join(dataDir, 'repos')
  if (pathInside(cwd, reposRoot)) return true
  return false
}
