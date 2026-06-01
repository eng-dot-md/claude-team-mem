// End-to-end tests for the claude-team-mem plugin, in two layers:
//
//  (1) UNIT — import the pure library functions and assert their contracts on the
//      edge cases distilled from the (bash) review: remote parsing (scp/https/ssh/
//      trailing-slash/nested), sameRepo normalization, slugForPath, isValidSlug,
//      isCircular, frontmatter (incl. a body containing a `---` line), and the
//      maxIndexBytes capping logic.
//
//  (2) INTEGRATION — drive the BUILT plugin/scripts/*.mjs (the artifacts esbuild
//      produces from src/bin/*) exactly as Claude Code / the skills would, via
//      execFileSync(node, [script], { env, cwd, input }). Each test runs in a fresh
//      mkdtemp world with an isolated HOME + CLAUDE_PLUGIN_DATA. The "remote" is a
//      BARE local git repo; a `~/.gitconfig` `insteadOf` rule redirects the
//      parseable SSH storage URL (git@github.com:acme/claude-team-memory.git) onto
//      that bare repo, so clone/fetch/push are fully OFFLINE — no network, no real
//      org touched. The native memory dir is built from the real slug rule and
//      seeded with real files. We then assert load/publish/unshare behavior end to
//      end against both the native dir and the bare remote.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  lstatSync,
  readlinkSync,
  existsSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseRemote, sameRepo, autoStorageUrl } from '../src/lib/remote'
import { parseFrontmatter, isValidSlug, readMemory } from '../src/lib/frontmatter'
import { slugForPath, pathInside } from '../src/lib/paths'
import { isCircular } from '../src/lib/guard'
import { resolve, specToStorageUrl } from '../src/resolve'
import { __internals } from '../src/load'

// ---------------------------------------------------------------------------
// Locations: the repo root and the BUILT script paths under plugin/scripts/.
// (These are produced by `pnpm build`; the test runner assumes they are fresh.)
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolvePath(here, '..')
const pluginRoot = join(repoRoot, 'plugin')
const LOAD = join(pluginRoot, 'scripts', 'load.mjs')
const PUBLISH = join(pluginRoot, 'scripts', 'publish.mjs')
const UNSHARE = join(pluginRoot, 'scripts', 'unshare.mjs')

// The parseable storage URL the plugin resolves to from origin acme/app + "auto".
// (autoStorageUrl(git@github.com:acme/app.git, "acme") === this.)
const STORAGE_URL = 'git@github.com:acme/claude-team-memory.git'
// Where checkoutDirFromUrl(STORAGE_URL) lands under <dataDir>/repos.
const CHECKOUT_SEGMENT = 'github.com__acme__claude-team-memory'
const PROJECT_KEY = 'acme/app' // <org>/<repo> subtree inside the storage repo

// ---------------------------------------------------------------------------
// Small descriptive assert helpers (give failures a clear "ctx: a !== b").
// ---------------------------------------------------------------------------

function eq<T>(actual: T, expected: T, ctx: string): void {
  assert.strictEqual(actual, expected, `${ctx}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
}
function ok(cond: unknown, ctx: string): void {
  assert.ok(cond, ctx)
}
function includes(haystack: string, needle: string, ctx: string): void {
  assert.ok(
    haystack.includes(needle),
    `${ctx}: expected to find ${JSON.stringify(needle)} in:\n${haystack}`,
  )
}
function notIncludes(haystack: string, needle: string, ctx: string): void {
  assert.ok(
    !haystack.includes(needle),
    `${ctx}: did NOT expect ${JSON.stringify(needle)} in:\n${haystack}`,
  )
}

// ===========================================================================
// (1) UNIT TESTS
// ===========================================================================

test('unit/parseRemote: scp-like, https(+trailing slash/.git), ssh(+user/port), nested', () => {
  eq(JSON.stringify(parseRemote('git@github.com:acme/app.git')),
    JSON.stringify({ host: 'github.com', owner: 'acme', repo: 'app' }), 'scp-like')

  eq(JSON.stringify(parseRemote('https://github.com/acme/app')),
    JSON.stringify({ host: 'github.com', owner: 'acme', repo: 'app' }), 'https bare')

  eq(JSON.stringify(parseRemote('https://github.com/acme/app.git/')),
    JSON.stringify({ host: 'github.com', owner: 'acme', repo: 'app' }), 'https trailing slash + .git')

  eq(JSON.stringify(parseRemote('ssh://git@gitlab.example.com:2222/group/sub/repo.git')),
    JSON.stringify({ host: 'gitlab.example.com', owner: 'group/sub', repo: 'repo' }), 'ssh:// user+port nested')

  // Nested forge path must NOT silently drop the middle segment.
  eq(JSON.stringify(parseRemote('https://gitlab.com/group/sub/team/repo')),
    JSON.stringify({ host: 'gitlab.com', owner: 'group/sub/team', repo: 'repo' }), 'nested preserved')

  eq(parseRemote('git@github.com:acme'), null, 'no repo -> null')
  eq(parseRemote('not a url'), null, 'garbage -> null')
  eq(parseRemote(''), null, 'empty -> null')
  eq(parseRemote(undefined), null, 'undefined -> null')
})

test('unit/sameRepo: normalizes trailing slash + .git across URL forms', () => {
  eq(sameRepo('git@github.com:acme/app.git', 'https://github.com/acme/app'), true, 'scp vs https same')
  eq(sameRepo('https://github.com/acme/app/', 'https://github.com/acme/app.git'), true, 'slash vs .git same')
  eq(sameRepo('git@github.com:acme/app.git', 'git@github.com:acme/other.git'), false, 'different repo')
  eq(sameRepo('git@github.com:acme/app.git', undefined), false, 'undefined side')
  // autoStorageUrl never collides with the project origin (basis for anti-circular).
  eq(sameRepo(autoStorageUrl('git@github.com:acme/app.git', 'acme'), 'git@github.com:acme/app.git'),
    false, 'storage != origin')
})

test('unit/slugForPath: every "/" and "." becomes "-"', () => {
  eq(slugForPath('/a/b.c'), '-a-b-c', '/a/b.c rule')
  eq(slugForPath('/Users/u/ws/app'), '-Users-u-ws-app', 'plain path')
  eq(slugForPath('/Users/u/my.proj.dir'), '-Users-u-my-proj-dir', 'dots in path')
})

test('unit/isValidSlug: allow dotted/leading-dot names, reject separators + traversal', () => {
  // ALLOW internal dots and dotted names.
  eq(isValidSlug('foo.md'), true, 'foo.md')
  eq(isValidSlug('api.v2.notes.md'), true, 'api.v2.notes.md')
  eq(isValidSlug('.env-notes.md'), true, '.env-notes.md (leading dot)')
  // REJECT separators / traversal / absolute.
  eq(isValidSlug('a/b.md'), false, 'has /')
  eq(isValidSlug('a\\b.md'), false, 'has backslash')
  eq(isValidSlug('../x.md'), false, '.. traversal')
  eq(isValidSlug('/x.md'), false, 'leading /')
  eq(isValidSlug('..'), false, 'bare ..')
  eq(isValidSlug('.'), false, 'bare .')
  eq(isValidSlug(''), false, 'empty')
  eq(isValidSlug(undefined), false, 'undefined')
})

test('unit/isCircular: storage==origin OR cwd inside <dataDir>/repos disables', () => {
  const dataDir = '/data'
  // storage URL same repo as origin (after .git/slash normalization) -> circular.
  eq(isCircular('git@github.com:acme/app.git', 'https://github.com/acme/app', '/proj', dataDir),
    true, 'storage == origin')
  // distinct storage repo + cwd outside any checkout -> not circular.
  eq(isCircular(STORAGE_URL, 'git@github.com:acme/app.git', '/proj', dataDir),
    false, 'distinct storage, normal cwd')
  // cwd inside <dataDir>/repos/... -> circular regardless of URLs.
  eq(isCircular(STORAGE_URL, 'git@github.com:acme/app.git', join(dataDir, 'repos', CHECKOUT_SEGMENT, 'acme', 'app'), dataDir),
    true, 'cwd inside a checkout')
})

test('unit/specToStorageUrl: auto / full URL / bare owner-repo', () => {
  const origin = 'git@github.com:acme/app.git'
  eq(specToStorageUrl('auto', origin, 'acme'), STORAGE_URL, 'auto')
  eq(specToStorageUrl('git@github.com:x/y.git', origin, 'acme'), 'git@github.com:x/y.git', 'full URL verbatim')
  eq(specToStorageUrl('globex/shared', origin, 'acme'), 'git@github.com:globex/shared.git', 'bare owner/repo grafted')
})

test('unit/frontmatter: a `---` line inside the body does NOT close the block', () => {
  const content = [
    '---',
    'name: Foo',
    'description: a fact',
    'metadata:',
    '  scope: team',
    '  origin: team',
    '---',
    'body line',
    '---', // this is body, not a fence
    'still body',
  ].join('\n')
  const { data, body } = parseFrontmatter(content)
  eq(data.name, 'Foo', 'name parsed')
  eq(data.description, 'a fact', 'description parsed')
  eq(JSON.stringify(data.metadata), JSON.stringify({ scope: 'team', origin: 'team' }), 'metadata block')
  eq(body, 'body line\n---\nstill body', 'body keeps the inner --- intact')

  // readMemory surfaces the same fields + body.
  const tmp = mkdtempSync(join(tmpdir(), 'ctm-fm-'))
  try {
    const f = join(tmp, 'x.md')
    writeFileSync(f, content, 'utf8')
    const mem = readMemory(f)
    eq(mem.name, 'Foo', 'readMemory name')
    eq(mem.metadata.scope, 'team', 'readMemory scope')
    eq(mem.metadata.origin, 'team', 'readMemory origin')
    includes(mem.body ?? '', '\n---\nstill body', 'readMemory body keeps inner ---')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('unit/buildIndexBody: maxIndexBytes caps at line boundaries, keeps >=1, appends "N more"', () => {
  const mk = (n: number) => ({ slug: `f${n}.md`, target: `/x/f${n}.md`, title: `Title ${n}` })
  const entries = [mk(1), mk(2), mk(3), mk(4), mk(5)]
  // Each rendered line: `- [Title N](fN.md) — team-shared memory` (no description -> generic hook).
  // (target paths don't exist on disk, so indexLine falls back to the generic hook — fine for this test.)

  const uncapped = __internals.buildIndexBody(entries, 0)
  eq(uncapped.split('\n').length, 5, 'uncapped keeps all 5 lines')
  notIncludes(uncapped, 'more', 'uncapped has no truncation note')

  // A cap that fits ~2 lines: expect a few kept lines + a single truncation note,
  // and the total byte size at/under the cap is NOT promised once the note is added,
  // but the kept body before the note must respect line boundaries (no split line).
  const full = uncapped.split('\n')
  const twoLineBytes = Buffer.byteLength(full.slice(0, 2).join('\n'), 'utf8')
  const capped = __internals.buildIndexBody(entries, twoLineBytes)
  const lines = capped.split('\n')
  ok(lines.length >= 2, 'capped keeps at least the entries that fit')
  ok(lines.length < entries.length + 1, 'capped dropped some entries')
  includes(capped, 'more', 'capped appends an "N more" note')
  // Every kept entry line is whole (starts with "- [").
  for (const ln of lines) {
    ok(ln.startsWith('- [') || ln.includes('more'), `line is a whole entry or the note: ${ln}`)
  }

  // A cap smaller than even one line still keeps exactly one entry (>=1 guarantee) + note.
  const tiny = __internals.buildIndexBody(entries, 1)
  const tinyLines = tiny.split('\n')
  ok(tinyLines.length >= 2, 'tiny cap keeps >=1 entry plus the note')
  ok(tinyLines[0]?.startsWith('- [') ?? false, 'tiny cap kept one whole entry first')
  includes(tiny, '4 more', 'tiny cap reports the other 4 as "4 more"')
})

// ===========================================================================
// (2) INTEGRATION TESTS — drive the built scripts in an isolated offline world.
// ===========================================================================

/** Run a built `.mjs` script under node with an isolated env; capture stdout/exit. */
function runScript(
  scriptPath: string,
  env: NodeJS.ProcessEnv,
  args: string[] = [],
  input = '',
): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [scriptPath, ...args], {
      env,
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 60_000,
    })
    return { stdout, stderr: '', status: 0 }
  } catch (err: unknown) {
    const e = err as { status?: number | null; stdout?: string | Buffer; stderr?: string | Buffer }
    const s = (v: string | Buffer | undefined): string => (v == null ? '' : typeof v === 'string' ? v : v.toString('utf8'))
    return { stdout: s(e.stdout), stderr: s(e.stderr), status: typeof e.status === 'number' ? e.status : 1 }
  }
}

/** A fully isolated, OFFLINE world: bare "remote", fake project, config, native dir. */
interface World {
  root: string
  home: string
  dataDir: string
  bare: string
  projectDir: string
  checkoutDir: string
  targetMemoryDir: string
  nativeDir: string
  /** Base env every child invocation should inherit (isolated HOME/data, plugin root). */
  env: NodeJS.ProcessEnv
}

/** Initialize a fresh world. `seedTeamFiles` are written into the bare remote's subtree. */
function makeWorld(seedTeamFiles: Record<string, string> = {}): World {
  const root = mkdtempSync(join(tmpdir(), 'ctm-e2e-'))
  const home = join(root, 'home')
  const dataDir = join(root, 'data')
  mkdirSync(home, { recursive: true })
  mkdirSync(dataDir, { recursive: true })

  // Child env: isolated HOME + data, plugin root pointed at our built plugin/.
  // No CLAUDE_CONFIG_DIR (so native base defaults to <home>/.claude). Non-interactive git.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    CLAUDE_PLUGIN_DATA: dataDir,
    CLAUDE_PLUGIN_ROOT: pluginRoot,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
  }
  delete env.CLAUDE_CONFIG_DIR
  delete env.CLAUDE_TEAM_MEMORY_REPO

  // git helper bound to this world's HOME (so insteadOf + identity are isolated).
  const git = (gitArgs: string[], cwd?: string): void => {
    execFileSync('git', gitArgs, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  }

  // 1. Bare repo = the storage "remote". Its default branch MUST be `main` (the
  //    branch we push below), so the bare HEAD symref resolves and a fresh clone
  //    checks out a working tree (otherwise: "remote HEAD refers to nonexistent
  //    ref, unable to checkout" -> empty worktree).
  const bare = join(root, 'storage.git')
  git(['init', '-q', '--bare', '--initial-branch=main', bare])

  // 1b. Seed it (optionally) by committing a worktree and pushing to the bare repo.
  const seed = join(root, 'seed')
  git(['init', '-q', seed])
  git(['config', 'user.email', 'seed@example.com'], seed)
  git(['config', 'user.name', 'Seed'], seed)
  git(['checkout', '-q', '-b', 'main'], seed)
  const subtree = join(seed, PROJECT_KEY, 'memory')
  mkdirSync(subtree, { recursive: true })
  // Always keep a .gitkeep so the subtree exists even with no seed files.
  writeFileSync(join(subtree, '.gitkeep'), '', 'utf8')
  for (const [name, body] of Object.entries(seedTeamFiles)) {
    writeFileSync(join(subtree, name), body, 'utf8')
  }
  git(['add', '-A'], seed)
  git(['commit', '-q', '-m', 'seed'], seed)
  git(['remote', 'add', 'origin', bare], seed)
  git(['push', '-q', '-u', 'origin', 'main'], seed)

  // 2. Fake project with a parseable origin (acme/app). "auto" -> STORAGE_URL.
  const projectDir = join(root, 'project')
  git(['init', '-q', projectDir])
  git(['remote', 'add', 'origin', 'git@github.com:acme/app.git'], projectDir)

  // 3. OFFLINE redirect: rewrite the SSH storage URL onto the local bare repo in
  //    THIS HOME's global gitconfig. clone/fetch/push then never touch the network.
  git(['config', '--global', `url.${bare}.insteadOf`, STORAGE_URL])
  // Give the redirected clone a committer identity for any local commits/pushes.
  git(['config', '--global', 'user.email', 'tester@example.com'])
  git(['config', '--global', 'user.name', 'Tester'])
  git(['config', '--global', 'init.defaultBranch', 'main'])

  // 4. Config: owner acme -> "auto" (resolves to STORAGE_URL, redirected to bare).
  writeFileSync(
    join(dataDir, 'config.json'),
    JSON.stringify({ owners: { acme: 'auto' }, maxIndexBytes: 20000 }, null, 2) + '\n',
    'utf8',
  )

  // 5. Native memory dir from the real slug rule; create the projects/<slug>/ parent
  //    (ensureNativeDir requires the parent to already exist, mirroring Claude Code).
  const slug = slugForPath(projectDir)
  const nativeDir = join(home, '.claude', 'projects', slug, 'memory')
  mkdirSync(nativeDir, { recursive: true })

  const checkoutDir = join(dataDir, 'repos', CHECKOUT_SEGMENT)
  const targetMemoryDir = join(checkoutDir, PROJECT_KEY, 'memory')

  return { root, home, dataDir, bare, projectDir, checkoutDir, targetMemoryDir, nativeDir, env }
}

function cleanup(w: World): void {
  rmSync(w.root, { recursive: true, force: true })
}

/** Drive load.mjs for a world: feed `{cwd: projectDir}` on stdin, parse additionalContext. */
function runLoad(w: World): { status: number; context: string | null; raw: string; stderr: string } {
  const res = runScript(LOAD, w.env, [], JSON.stringify({ cwd: w.projectDir }))
  let context: string | null = null
  const out = res.stdout.trim()
  if (out.length > 0) {
    const parsed = JSON.parse(out) as { hookSpecificOutput?: { additionalContext?: string } }
    context = parsed.hookSpecificOutput?.additionalContext ?? null
  }
  return { status: res.status, context, raw: res.stdout, stderr: res.stderr }
}

/** List the team files committed in the BARE remote (source of truth for "pushed"). */
function bareFiles(w: World): string[] {
  try {
    const out = execFileSync('git', ['-C', w.bare, 'ls-tree', '-r', '--name-only', 'main'], {
      env: w.env,
      encoding: 'utf8',
    })
    return out.split('\n').filter((l) => l.length > 0)
  } catch {
    return []
  }
}

/** Read a file's bytes committed in the BARE remote at `path` (relative), or null. */
function bareShow(w: World, relPath: string): string | null {
  try {
    return execFileSync('git', ['-C', w.bare, 'show', `main:${relPath}`], { env: w.env, encoding: 'utf8' })
  } catch {
    return null
  }
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

// A TEAMMATE-authored file as it lives in the storage repo: it carries
// metadata.origin: team. Used for load (seeded by a teammate) and to exercise the
// publish provenance backstop (a team-origin file must never be re-published).
const TEAM_FILE = [
  '---',
  'name: Deploy Runbook',
  'description: how the team deploys to prod',
  'metadata:',
  '  type: project',
  '  scope: team',
  '  origin: team',
  '---',
  '# Deploy Runbook',
  'Steps to deploy.',
  '',
].join('\n')

// A file the LOCAL user is sharing for the first time: scope team, but NO
// origin:team marker (that marker is stamped only on already-shared/team-origin
// files). This is what /share-memory writes into the checkout before publish().
const PUBLISHABLE_FILE = [
  '---',
  'name: Deploy Runbook',
  'description: how the team deploys to prod',
  'metadata:',
  '  type: project',
  '  scope: team',
  '---',
  '# Deploy Runbook',
  'Steps to deploy.',
  '',
].join('\n')

const PERSONAL_FILE = [
  '---',
  'name: My Scratch Note',
  'metadata:',
  '  scope: personal',
  '---',
  'private musings',
  '',
].join('\n')

// --- LOAD ------------------------------------------------------------------

test('integration/load: clones, symlinks a teammate file, injects index with its title, leaves a personal real file untouched', () => {
  const w = makeWorld({ 'teammate-bar.md': TEAM_FILE })
  try {
    // A personal real file already present in the native dir (must NOT be touched).
    const personalPath = join(w.nativeDir, 'my-personal.md')
    writeFileSync(personalPath, PERSONAL_FILE, 'utf8')

    const r = runLoad(w)
    eq(r.status, 0, 'load exits 0')
    ok(r.context !== null, `load injected context (stderr: ${r.stderr})`)
    const ctx = r.context ?? ''

    // Index includes the teammate file's derived title + description hook.
    includes(ctx, 'Deploy Runbook', 'index has the teammate title')
    includes(ctx, 'teammate-bar.md', 'index references the slug')
    includes(ctx, 'how the team deploys to prod', 'index uses the description as the hook')
    // Preamble present.
    includes(ctx, 'Team-shared memory', 'preamble present')

    // The clone happened at the derived checkout dir and has the real bytes.
    ok(existsSync(join(w.targetMemoryDir, 'teammate-bar.md')), 'checkout has the real teammate bytes')

    // A symlink was created in the native dir, pointing INTO the checkout (absolute).
    const link = join(w.nativeDir, 'teammate-bar.md')
    ok(isSymlink(link), 'native teammate-bar.md is a symlink')
    const target = readlinkSync(link)
    ok(target.startsWith('/'), `symlink target is absolute (${target})`)
    ok(pathInside(target, w.checkoutDir), 'symlink resolves into the checkout')
    eq(resolvePath(target), resolvePath(join(w.targetMemoryDir, 'teammate-bar.md')), 'symlink points at the right file')

    // The personal real file is UNTOUCHED (still a real file, same bytes).
    ok(!isSymlink(personalPath), 'personal file is still a real file (not a symlink)')
    eq(readFileSync(personalPath, 'utf8'), PERSONAL_FILE, 'personal file bytes unchanged')
    notIncludes(ctx, 'My Scratch Note', 'personal file is NOT advertised in the team index')
  } finally {
    cleanup(w)
  }
})

test('integration/load: prunes a dangling symlink that resolves INTO the checkout, never a real file or out-of-checkout link', () => {
  const w = makeWorld({ 'teammate-bar.md': TEAM_FILE })
  try {
    // First load establishes the real checkout (so we can craft links into it).
    runLoad(w)

    // (a) Dangling symlink INTO the checkout (target does not exist) -> must be pruned.
    const danglingTarget = join(w.targetMemoryDir, 'ghost.md') // not present in checkout
    const danglingLink = join(w.nativeDir, 'ghost.md')
    symlinkSync(danglingTarget, danglingLink)
    ok(isSymlink(danglingLink), 'precondition: dangling link exists')

    // (b) A real file that must NEVER be pruned.
    const realKeep = join(w.nativeDir, 'keep-me.md')
    writeFileSync(realKeep, 'keep this real file\n', 'utf8')

    // (c) A symlink pointing OUTSIDE the checkout -> must NOT be pruned (unrelated).
    const outsideTarget = join(w.root, 'outside-target.md')
    writeFileSync(outsideTarget, 'outside\n', 'utf8')
    const outsideLink = join(w.nativeDir, 'outside.md')
    symlinkSync(outsideTarget, outsideLink)

    const r = runLoad(w)
    eq(r.status, 0, 'second load exits 0')

    ok(!existsSync(danglingLink) && !isSymlink(danglingLink), 'dangling-into-checkout symlink was pruned')
    ok(existsSync(realKeep), 'real file was NOT pruned')
    eq(readFileSync(realKeep, 'utf8'), 'keep this real file\n', 'real file bytes intact')
    ok(isSymlink(outsideLink), 'out-of-checkout symlink was NOT pruned')

    // The legitimate teammate symlink survives (idempotent, not thrashed/pruned).
    ok(isSymlink(join(w.nativeDir, 'teammate-bar.md')), 'teammate symlink still present after re-run')
  } finally {
    cleanup(w)
  }
})

test('integration/load: a real-vs-team name clash is SURFACED, not overwritten', () => {
  const w = makeWorld({ 'teammate-bar.md': TEAM_FILE })
  try {
    // A native REAL file shadowing the team slug. Load must flag it and leave it alone.
    const clashPath = join(w.nativeDir, 'teammate-bar.md')
    const localBytes = '# my own local teammate-bar\nlocal content\n'
    writeFileSync(clashPath, localBytes, 'utf8')

    const r = runLoad(w)
    eq(r.status, 0, 'load exits 0')
    const ctx = r.context ?? ''

    // Clash surfaced in the injected context.
    includes(ctx, 'Name clashes', 'clash section present')
    includes(ctx, 'teammate-bar.md', 'clash names the slug')

    // The real file is untouched (NOT converted to a symlink, bytes unchanged).
    ok(!isSymlink(clashPath), 'clashing real file is still a real file')
    eq(readFileSync(clashPath, 'utf8'), localBytes, 'clashing real file bytes unchanged')
  } finally {
    cleanup(w)
  }
})

// --- PUBLISH ---------------------------------------------------------------

/**
 * Simulate the /share-memory skill having already written the final sanitized bytes
 * into the checkout target dir, then drive publish.mjs for the named slugs.
 * (publish() is mechanics-only: it stages/commits/pushes what is in the target dir.)
 */
function runPublish(w: World, slugs: string[], extra: string[] = []): {
  status: number
  result: import('../src/publish').PublishResult
  stderr: string
} {
  const args = ['--checkout-dir', w.checkoutDir, '--target-dir', w.targetMemoryDir, '--native-dir', w.nativeDir]
  for (const s of slugs) args.push('--slug', s)
  args.push(...extra)
  const res = runScript(PUBLISH, w.env, args)
  const result = JSON.parse(res.stdout.trim()) as import('../src/publish').PublishResult
  return { status: res.status, result, stderr: res.stderr }
}

test('integration/publish: writes+pushes a team file (appears in the bare remote), converts identical local to a symlink', () => {
  const w = makeWorld() // empty remote
  try {
    // Establish the checkout first (clone the empty-but-seeded remote).
    runLoad(w)

    // The skill wrote the sanitized team file into BOTH the checkout target dir
    // (the bytes to publish) and left an IDENTICAL real file in the native dir
    // (the local copy that should get converted to a symlink on success).
    const slug = 'foo.md'
    writeFileSync(join(w.targetMemoryDir, slug), PUBLISHABLE_FILE, 'utf8')
    const nativeFoo = join(w.nativeDir, slug)
    writeFileSync(nativeFoo, PUBLISHABLE_FILE, 'utf8')

    const { status, result, stderr } = runPublish(w, [slug])
    eq(status, 0, 'publish exits 0')
    eq(result.published, true, `published true (reason: ${result.reason}; stderr: ${stderr})`)
    eq(result.pushed, true, `pushed true (reason: ${result.reason})`)
    eq(result.committed, true, 'committed true')

    // It is now in the BARE remote.
    const inBare = bareFiles(w)
    ok(inBare.includes(`${PROJECT_KEY}/memory/${slug}`), `foo.md pushed to bare remote (got ${JSON.stringify(inBare)})`)
    eq(bareShow(w, `${PROJECT_KEY}/memory/${slug}`), PUBLISHABLE_FILE, 'bare remote has the exact bytes')

    // The identical local real file was converted to an ABSOLUTE symlink into the checkout.
    ok(isSymlink(nativeFoo), 'identical local file converted to a symlink')
    const tgt = readlinkSync(nativeFoo)
    ok(tgt.startsWith('/'), `symlink is absolute (${tgt})`)
    ok(pathInside(tgt, w.checkoutDir), 'symlink resolves into the checkout')

    const fooResult = result.slugs.find((s) => s.slug === slug)
    ok(fooResult?.linked === true, `slug result marks linked (${JSON.stringify(fooResult)})`)
  } finally {
    cleanup(w)
  }
})

test('integration/publish: keeps a DIVERGENT local file as a real file (no data loss)', () => {
  const w = makeWorld()
  try {
    runLoad(w)

    // Skill wrote a SANITIZED copy into the checkout; the local native file still
    // holds the UNSANITIZED (divergent) bytes -> must be kept as a real file.
    const slug = 'secret.md'
    const sanitized = PUBLISHABLE_FILE
    const localDivergent = PUBLISHABLE_FILE + '\nLOCAL ONLY: token=abc123 (kept back)\n'
    writeFileSync(join(w.targetMemoryDir, slug), sanitized, 'utf8')
    const nativePath = join(w.nativeDir, slug)
    writeFileSync(nativePath, localDivergent, 'utf8')

    const { status, result } = runPublish(w, [slug])
    eq(status, 0, 'publish exits 0')
    eq(result.pushed, true, 'sanitized copy pushed')
    eq(bareShow(w, `${PROJECT_KEY}/memory/${slug}`), sanitized, 'remote got the sanitized copy')

    // Local divergent file kept as-is (NOT a symlink, bytes preserved).
    ok(!isSymlink(nativePath), 'divergent local file is still a real file')
    eq(readFileSync(nativePath, 'utf8'), localDivergent, 'divergent local bytes preserved')
    const slugResult = result.slugs.find((s) => s.slug === slug)
    ok(slugResult?.keptLocal === true && slugResult?.linked === false, `kept local, not linked (${JSON.stringify(slugResult)})`)
  } finally {
    cleanup(w)
  }
})

test('integration/publish: idempotent — re-running produces NO -2 duplicate and no second commit', () => {
  const w = makeWorld()
  try {
    runLoad(w)
    const slug = 'idem.md'
    writeFileSync(join(w.targetMemoryDir, slug), PUBLISHABLE_FILE, 'utf8')
    writeFileSync(join(w.nativeDir, slug), PUBLISHABLE_FILE, 'utf8')

    const first = runPublish(w, [slug])
    eq(first.result.pushed, true, `first publish pushed (reason: ${first.result.reason})`)
    const commitsAfterFirst = execFileSync('git', ['-C', w.bare, 'rev-list', '--count', 'main'], {
      env: w.env,
      encoding: 'utf8',
    }).trim()

    // Second run: target bytes are byte-identical to HEAD -> dedupe no-op (no commit).
    const second = runPublish(w, [slug])
    eq(second.status, 0, 'second publish exits 0')
    eq(second.result.published, true, 'second publish still "published" (clean no-op)')
    eq(second.result.committed, false, 'second publish committed nothing')
    eq(second.result.pushed, false, 'second publish pushed nothing')

    const commitsAfterSecond = execFileSync('git', ['-C', w.bare, 'rev-list', '--count', 'main'], {
      env: w.env,
      encoding: 'utf8',
    }).trim()
    eq(commitsAfterSecond, commitsAfterFirst, 'no new commit on the idempotent re-run')

    // No `idem-2.md` (or any -2 variant) was created anywhere.
    const bareList = bareFiles(w)
    ok(!bareList.some((f) => f.includes('idem-2')), `no -2 duplicate in remote (${JSON.stringify(bareList)})`)
    ok(!readdirSync(w.targetMemoryDir).some((f) => f.includes('idem-2')), 'no -2 duplicate in checkout')
  } finally {
    cleanup(w)
  }
})

test('integration/publish: NEVER deletes the checkout copy when the local native file is absent', () => {
  const w = makeWorld({ 'teammate-bar.md': TEAM_FILE })
  try {
    runLoad(w)
    // The teammate file exists in the checkout but there is NO local real file to
    // publish — and notably no slug bytes the skill wrote. Publishing the slug must
    // not delete the existing checkout copy (publish is never a deleter; §7.4).
    const slug = 'teammate-bar.md'
    ok(existsSync(join(w.targetMemoryDir, slug)), 'precondition: checkout has the teammate file')

    // Drive publish for that slug WITHOUT changing the checkout bytes (no skill write).
    // It is byte-identical to HEAD -> a clean no-op; the checkout copy must survive.
    const { status, result } = runPublish(w, [slug])
    eq(status, 0, 'publish exits 0')
    ok(existsSync(join(w.targetMemoryDir, slug)), 'checkout copy still present (publish never deletes)')

    // The bare remote still has the file (nothing was removed/pushed-as-deletion).
    ok(bareFiles(w).includes(`${PROJECT_KEY}/memory/${slug}`), 'remote still has the teammate file')
    // (origin:team provenance backstop also applies: this seed carries origin:team.)
    const slugResult = result.slugs.find((s) => s.slug === slug)
    ok(slugResult !== undefined, 'slug appears in results')
  } finally {
    cleanup(w)
  }
})

test('integration/publish: REFUSES a tombstoned slug and SKIPS a metadata.origin:team file', () => {
  const w = makeWorld()
  try {
    runLoad(w)

    // (a) Tombstoned slug: place a tombstone, then ask to publish that slug.
    const tomb = 'retracted.md'
    const tombDir = join(w.targetMemoryDir, '.tombstones')
    mkdirSync(tombDir, { recursive: true })
    writeFileSync(join(tombDir, tomb), '---\ntombstone: true\n---\nremoved\n', 'utf8')
    writeFileSync(join(w.targetMemoryDir, tomb), TEAM_FILE, 'utf8') // bytes present but tombstoned

    // (b) team-origin file: TEAM_FILE carries metadata.origin: team -> must be skipped.
    const teamOrigin = 'from-team.md'
    writeFileSync(join(w.targetMemoryDir, teamOrigin), TEAM_FILE, 'utf8')

    const { status, result } = runPublish(w, [tomb, teamOrigin])
    eq(status, 0, 'publish exits 0')

    const tombRes = result.slugs.find((s) => s.slug === tomb)
    ok(tombRes !== undefined && tombRes.accepted === false, `tombstoned slug refused (${JSON.stringify(tombRes)})`)
    includes(tombRes?.note ?? '', 'tombstone', 'refusal note mentions the tombstone')

    const teamRes = result.slugs.find((s) => s.slug === teamOrigin)
    ok(teamRes !== undefined && teamRes.accepted === false, `team-origin slug skipped (${JSON.stringify(teamRes)})`)
    includes(teamRes?.note ?? '', 'team', 'skip note mentions team provenance')

    // Neither was pushed to the remote.
    eq(result.pushed, false, 'nothing pushed (all refused/skipped)')
    const bare = bareFiles(w)
    ok(!bare.includes(`${PROJECT_KEY}/memory/${tomb}`), 'tombstoned slug not resurrected in remote')
    ok(!bare.includes(`${PROJECT_KEY}/memory/${teamOrigin}`), 'team-origin slug not published to remote')
  } finally {
    cleanup(w)
  }
})

// --- UNSHARE ---------------------------------------------------------------

test('integration/unshare: writes a tombstone, removes the file, and pushes the removal', () => {
  const w = makeWorld({ 'doomed.md': TEAM_FILE })
  try {
    runLoad(w) // clone so the checkout has the file
    const slug = 'doomed.md'
    ok(existsSync(join(w.targetMemoryDir, slug)), 'precondition: checkout has the file')
    ok(bareFiles(w).includes(`${PROJECT_KEY}/memory/${slug}`), 'precondition: remote has the file')

    const res = runScript(UNSHARE, w.env, [
      '--checkout-dir', w.checkoutDir,
      '--target-dir', w.targetMemoryDir,
      '--slug', slug,
      '--reason', 'stale; superseded',
      '--by', 'tester',
    ])
    eq(res.status, 0, `unshare exits 0 (stderr: ${res.stderr}; stdout: ${res.stdout})`)
    const result = JSON.parse(res.stdout.trim()) as import('../src/unshare').UnshareResult
    eq(result.removed, true, 'removed true')
    eq(result.pushed, true, 'pushed true')
    eq(result.notFound, false, 'notFound false')
    ok(result.tombstone !== null, 'tombstone path reported')

    // The shared file is gone from the checkout AND the bare remote.
    ok(!existsSync(join(w.targetMemoryDir, slug)), 'file removed from checkout')
    const bare = bareFiles(w)
    ok(!bare.includes(`${PROJECT_KEY}/memory/${slug}`), 'file removed from remote (deletion pushed)')

    // A tombstone exists in both the checkout and the remote.
    const tombRel = `${PROJECT_KEY}/memory/.tombstones/${slug}`
    ok(existsSync(join(w.targetMemoryDir, '.tombstones', slug)), 'tombstone present in checkout')
    ok(bare.includes(tombRel), `tombstone pushed to remote (${JSON.stringify(bare)})`)
    const tombBody = bareShow(w, tombRel) ?? ''
    includes(tombBody, 'tombstone: true', 'tombstone has the marker frontmatter')
    includes(tombBody, 'stale; superseded', 'tombstone records the reason')

    // After unshare, publish REFUSES to resurrect the slug (closes the loop).
    writeFileSync(join(w.targetMemoryDir, slug), TEAM_FILE, 'utf8')
    const re = runPublish(w, [slug])
    const reSlug = re.result.slugs.find((s) => s.slug === slug)
    ok(reSlug?.accepted === false, `publish refuses the tombstoned slug after unshare (${JSON.stringify(reSlug)})`)
  } finally {
    cleanup(w)
  }
})

test('integration/unshare: an untracked slug in the checkout is refused cleanly (no tombstone, no partial state)', () => {
  const w = makeWorld({ 'shared.md': TEAM_FILE })
  try {
    runLoad(w) // clone the checkout
    // A file present in the target dir but NEVER published => untracked in the checkout.
    const slug = 'never-shared.md'
    writeFileSync(join(w.targetMemoryDir, slug), TEAM_FILE, 'utf8')

    const res = runScript(UNSHARE, w.env, [
      '--checkout-dir', w.checkoutDir,
      '--target-dir', w.targetMemoryDir,
      '--slug', slug,
      '--reason', 'oops',
      '--by', 'tester',
    ])
    eq(res.status, 3, `unshare exits 3 (stable notFound code) for an untracked slug (stderr: ${res.stderr}; stdout: ${res.stdout})`)
    const result = JSON.parse(res.stdout.trim()) as import('../src/unshare').UnshareResult
    eq(result.removed, false, 'removed false (the slug was never shared upstream)')
    eq(result.notFound, true, 'notFound true for an untracked slug')

    // No partial state: the untracked file is left in place and NO tombstone is written.
    ok(existsSync(join(w.targetMemoryDir, slug)), 'untracked file left untouched (not deleted)')
    ok(!existsSync(join(w.targetMemoryDir, '.tombstones', slug)), 'no tombstone written for an unshared slug')
  } finally {
    cleanup(w)
  }
})

// --- FAILURE-PATH REGRESSIONS (from the Codex adversarial review) ----------
// These exercise what the happy-path suite never did: a clone that FAILS, and a
// push that FAILS then a RERUN. None may report a local-only state as success.

/** Point the checkout's `origin` at `url` (break it with a bad path; restore with w.bare). */
function setOrigin(w: World, url: string): void {
  execFileSync('git', ['-C', w.checkoutDir, 'remote', 'set-url', 'origin', url], {
    env: w.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

test('integration/resolve: a failed first-run clone degrades to DISABLED (not enabled with a missing checkout)', () => {
  const w = makeWorld({ 'x.md': TEAM_FILE })
  try {
    // Make the checkout location a NON-empty, non-git dir so `git clone` into it
    // fails locally — simulating a first-run clone failure (offline / auth / bad URL).
    mkdirSync(w.checkoutDir, { recursive: true })
    writeFileSync(join(w.checkoutDir, 'junk'), 'x', 'utf8')

    // resolve() reads process.env; point it at this world (HOME keeps the offline
    // insteadOf redirect active so nothing touches the network), then restore.
    const saved = {
      HOME: process.env.HOME,
      DATA: process.env.CLAUDE_PLUGIN_DATA,
      CFG: process.env.CLAUDE_CONFIG_DIR,
      REPO: process.env.CLAUDE_TEAM_MEMORY_REPO,
    }
    process.env.HOME = w.home
    process.env.CLAUDE_PLUGIN_DATA = w.dataDir
    delete process.env.CLAUDE_CONFIG_DIR
    delete process.env.CLAUDE_TEAM_MEMORY_REPO
    try {
      const r = resolve(w.projectDir)
      eq(r.enabled, false, `clone failure must degrade to disabled (got ${JSON.stringify(r)})`)
    } finally {
      const restore = (k: 'HOME' | 'CLAUDE_PLUGIN_DATA' | 'CLAUDE_CONFIG_DIR' | 'CLAUDE_TEAM_MEMORY_REPO', v: string | undefined): void => {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      restore('HOME', saved.HOME)
      restore('CLAUDE_PLUGIN_DATA', saved.DATA)
      restore('CLAUDE_CONFIG_DIR', saved.CFG)
      restore('CLAUDE_TEAM_MEMORY_REPO', saved.REPO)
    }
  } finally {
    cleanup(w)
  }
})

test('integration/publish: a rerun after a FAILED push lands the pending commit (no false success)', () => {
  const w = makeWorld() // empty-but-seeded remote (origin/main exists)
  try {
    runLoad(w) // clone the checkout
    const slug = 'note.md'
    writeFileSync(join(w.targetMemoryDir, slug), PUBLISHABLE_FILE, 'utf8')

    // Break the remote so the push fails AFTER the local commit.
    setOrigin(w, join(w.root, 'gone.git'))
    const r1 = runPublish(w, [slug])
    eq(r1.result.published, false, `first publish reports failure when the push fails (reason: ${r1.result.reason})`)
    ok(!bareFiles(w).includes(`${PROJECT_KEY}/memory/${slug}`), 'remote does NOT have the file yet')

    // Restore the remote; the rerun must FLUSH the pending commit, not falsely no-op.
    setOrigin(w, w.bare)
    const r2 = runPublish(w, [slug])
    eq(r2.result.published, true, `rerun publishes by flushing the pending commit (reason: ${r2.result.reason})`)
    eq(r2.result.pushed, true, 'rerun reports pushed true')
    ok(bareFiles(w).includes(`${PROJECT_KEY}/memory/${slug}`), 'remote now has the file')
  } finally {
    cleanup(w)
  }
})

test('integration/unshare: a rerun after a FAILED push flushes the pending removal (not a false notFound)', () => {
  const w = makeWorld({ 'doomed.md': TEAM_FILE })
  try {
    runLoad(w)
    const slug = 'doomed.md'

    // Break the remote so the unshare push fails after the local removal commit.
    setOrigin(w, join(w.root, 'gone.git'))
    const a = runScript(UNSHARE, w.env, [
      '--checkout-dir', w.checkoutDir, '--target-dir', w.targetMemoryDir, '--slug', slug, '--reason', 'stale',
    ])
    const r1 = JSON.parse(a.stdout.trim()) as import('../src/unshare').UnshareResult
    eq(r1.removed, true, 'removal committed locally')
    eq(r1.pushed, false, 'push failed (remote broken)')
    ok(bareFiles(w).includes(`${PROJECT_KEY}/memory/${slug}`), 'remote STILL has the file (push failed)')

    // Restore the remote; the rerun must flush the pending removal, NOT report notFound.
    setOrigin(w, w.bare)
    const b = runScript(UNSHARE, w.env, [
      '--checkout-dir', w.checkoutDir, '--target-dir', w.targetMemoryDir, '--slug', slug, '--reason', 'stale',
    ])
    const r2 = JSON.parse(b.stdout.trim()) as import('../src/unshare').UnshareResult
    eq(r2.notFound, false, `rerun does NOT report notFound (stdout: ${b.stdout})`)
    eq(r2.removed, true, 'rerun reports removed (flushed)')
    eq(r2.pushed, true, 'rerun flushed the pending push')
    ok(!bareFiles(w).includes(`${PROJECT_KEY}/memory/${slug}`), 'remote no longer has the file')
  } finally {
    cleanup(w)
  }
})

// --- REGRESSIONS from the second /code-review (resolve.mjs + publish honesty) ---

test('integration/resolve.mjs: prints enabled:true with the resolved paths and performs the clone', () => {
  const w = makeWorld({ 'x.md': TEAM_FILE })
  try {
    const res = runScript(join(pluginRoot, 'scripts', 'resolve.mjs'), w.env, ['--cwd', w.projectDir])
    eq(res.status, 0, `resolve exits 0 (stderr: ${res.stderr})`)
    const r = JSON.parse(res.stdout.trim()) as import('../src/types').Resolution
    eq(r.enabled, true, `enabled true (reason: ${r.reason})`)
    eq(r.projectKey, PROJECT_KEY, 'projectKey is acme/app')
    eq(r.checkoutDir, w.checkoutDir, 'checkoutDir matches the world')
    eq(r.targetMemoryDir, w.targetMemoryDir, 'targetMemoryDir matches the world')
    eq(r.nativeMemoryDir, w.nativeDir, 'nativeMemoryDir matches the world')
    ok(existsSync(join(w.checkoutDir, '.git')), 'resolve performed the (full) clone')
    // The same source of truth the skills now consume — not re-derived in bash.
  } finally {
    cleanup(w)
  }
})

test('integration/resolve.mjs: an unconfigured owner resolves to enabled:false', () => {
  const w = makeWorld()
  try {
    // Rewrite config so owner "acme" is no longer mapped.
    writeFileSync(join(w.dataDir, 'config.json'), JSON.stringify({ owners: {}, maxIndexBytes: 20000 }) + '\n', 'utf8')
    const res = runScript(join(pluginRoot, 'scripts', 'resolve.mjs'), w.env, ['--cwd', w.projectDir])
    eq(res.status, 0, 'resolve exits 0 even when disabled')
    const r = JSON.parse(res.stdout.trim()) as import('../src/types').Resolution
    eq(r.enabled, false, `unconfigured owner -> disabled (reason: ${r.reason})`)
  } finally {
    cleanup(w)
  }
})

test('integration/publish: a --slug absent from the checkout reports published:false (no false success)', () => {
  const w = makeWorld({ 'other.md': TEAM_FILE })
  try {
    runLoad(w) // clone the checkout
    // Publish a slug that was NEVER written into the checkout target.
    const r = runPublish(w, ['ghost.md'])
    eq(r.result.published, false, `absent slug must NOT report published:true (reason: ${r.result.reason})`)
    ok(!bareFiles(w).includes(`${PROJECT_KEY}/memory/ghost.md`), 'nothing pushed for the absent slug')
  } finally {
    cleanup(w)
  }
})

test('integration/publish: a --target-dir outside the checkout is refused', () => {
  const w = makeWorld()
  try {
    runLoad(w)
    const outside = join(w.root, 'outside-memory')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'x.md'), PUBLISHABLE_FILE, 'utf8')
    const r = runPublish({ ...w, targetMemoryDir: outside }, ['x.md'])
    eq(r.result.published, false, `target outside the checkout must be refused (reason: ${r.result.reason})`)
    includes(r.result.reason, 'not inside the checkout', 'reason explains the structural refusal')
  } finally {
    cleanup(w)
  }
})
