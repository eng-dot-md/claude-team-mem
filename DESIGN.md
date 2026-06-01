# claude-team-mem — Design

A lightweight Claude Code plugin that shares a team-relevant subset of Claude's
per-project memory across a team. It is built **on top of** Claude's native
file-based memory, not as a replacement.

> Status: design spec. The plugin is built per §12 (Build plan).

## 1. Goals & principles

- **Build on native memory.** Native memory stays the authoring + recall engine.
  The plugin is only a thin **git sync layer** — classify → publish → load —
  organized per project and per team.
- **Lightweight.** Git is the transport, the store, and the merge model. No
  server, no database.
- **Explicit opt-in.** The plugin activates only for GitHub owners listed in a
  config — not for every repo. Repos you merely cloned (open source, forks, …)
  are never touched.
- **Safe.** The storage repo is private; the team path always sanitizes;
  duplicate and circular creation are prevented structurally; conflicts
  auto-resolve; shared storage is never deleted implicitly.

## 2. Two repos — keep them distinct (the basis for "no circular creation")

| Role | Repo | Holds | Lifecycle |
|---|---|---|---|
| **Plugin** (the tool) | `eng-dot-md/claude-team-mem` | code only: hooks / skills / scripts | installed via marketplace |
| **Storage** (the data) | configured per team (one or more orgs) | the actual memory, one subtree per project keyed `<org>/<repo>` | created once per team |

```
  local, per machine                          Storage repo (private, per team)
  native memory + plugin's symlink layer  ──publish──▶  <org>/<repo>/memory/<slug>.md
                                          ◀───load───   (the only physical copy lives here)
```

A team's storage repo can hold projects from **several GitHub orgs**; that is why
entries are keyed by `<org>/<repo>` (not just the repo name) — see §3.

## 3. Resolution: owner → storage repo (config-driven)

For whatever project you are in, resolve its storage repo in this order:

1. **Env var `CLAUDE_TEAM_MEMORY_REPO`** (full git URL or `owner/repo`) — a
   per-project override.
2. **Config lookup by owner** (parse host + owner + protocol from the project's
   `origin` remote):
   - hit → use the mapped value (`"auto"` = `<host>:<owner>/claude-team-memory`,
     or an explicit `owner/repo` / full git URL);
   - miss → **disabled; the plugin no-ops for that repo.**
3. **Anti-circular guard** on top: if the resolved storage repo URL equals the
   current project's `origin`, or cwd is inside a plugin-data checkout → disabled.

- **Project key** (subtree inside the storage repo) = **`<org>/<repo>`** — the
  project's owner **and** repo name, e.g. `acme/app/`, `acme/lib/`, `globex/api/`.
  Keying by `<org>/<repo>` (not just the repo name) lets **one storage repo serve a
  team spanning multiple GitHub orgs** without collisions (`acme/app` vs
  `globex/app`).
- **Local checkout is keyed by the resolved storage-repo identity**, not by the
  project owner:
  `${CLAUDE_PLUGIN_DATA}/repos/<storage-host>__<storage-owner>__<storage-repo>/`.
  So two projects that override (`CLAUDE_TEAM_MEMORY_REPO` / explicit URLs) to
  *different* storage repos never share a checkout (no cross-corruption), and
  several orgs mapped to the *same* storage repo share one checkout. The
  `<org>/<repo>` project key is a subtree inside that checkout.

**Config** lives at `${CLAUDE_PLUGIN_DATA}/config.json` (managed via the
`/team-memory` skill). `CLAUDE_PLUGIN_DATA` is provided by Claude Code; when unset
(e.g. running the scripts outside the plugin) it defaults to `~/.claude-team-mem`,
so the default config path is `~/.claude-team-mem/config.json`:

```json
{
  "owners": {
    "acme":      "auto",
    "acme-labs": "git@github.com:acme/claude-team-memory.git",
    "globex":    "git@github.com:globex/shared-claude-mem.git"
  },
  "maxIndexBytes": 20000
}
```

- `"auto"` resolves to `<owner>/claude-team-memory` (same host/protocol as the project).
- **Multi-org team:** point several orgs at one repo (here `acme` + `acme-labs` →
  `acme/claude-team-memory`); their projects stay separated by the `<org>/<repo>`
  key (`acme/app`, `acme-labs/app`).
- Owners not listed are no-ops — **no team is forced to put memory anywhere it
  doesn't configure**, and each org can equally have its own repo.

## 4. Local layout — shared memory lives as symlinks in the native dir

```
~/.claude/projects/<repo-hash>/memory/        ← native memory dir for this project
├─ my-personal.md           real file · personal · never leaves the machine
├─ unpublished-idea.md      real file · not yet published
├─ foo.md                   symlink ┐  (one you published)
└─ teammate-bar.md          symlink ┤  (one a teammate shared)
                                    ▼
${CLAUDE_PLUGIN_DATA}/repos/<storage-host>__<storage-owner>__<storage-repo>/   ← clone (real bytes)
└─ <org>/<repo>/memory/{foo.md, teammate-bar.md}
```

**Core idea:** the real bytes for a shared fact live in the checkout exactly
once; the native dir holds a **symlink** to it. Consequences:

- **Local is not deleted** — on publish, the local real file is converted to a
  symlink **only when its content is identical to the published copy**. If
  sanitization or a merge changed the shared copy, the local real file is **kept**
  (§7.8), so local-only content is never silently discarded.
- **No duplication** — a fact has a single physical copy, so it can never appear
  twice in context.
- **Native recall is preserved** — the native memory system follows symlinks.
- **Offline fallback** — the checkout is a local cache; shared memory is still
  readable offline.

So the native dir = `{real files: personal / unpublished / kept-back memory}` ∪
`{symlinks: published team memory (yours + teammates')}`.

## 5. Classification (personal vs team)

- **Authoritative:** frontmatter `metadata.scope: team | personal`.
- **Untagged (legacy)** — classify by content: `type: project|reference|feedback`
  → team candidate; `type: user` / personal preferences / machine-specific quirks
  → personal; **when unsure → personal** (sharing is opt-in).
- **Sanitization is mandatory** on the team path: strip secrets, tokens, auth-bearing
  URLs, personal asides, and anything the workspace `CLAUDE.md` forbids exposing.
  The storage repo is private, but sanitize anyway.
- v2: write `scope` at memory-creation time so classification is decided up front.

## 6. Load (SessionStart `command` hook → `node scripts/load.mjs`)

The hook runs `node "$CLAUDE_PLUGIN_ROOT/scripts/load.mjs"` (the bundle of
`src/bin/load.ts`). It reads the SessionStart payload from stdin to get `cwd`,
then:

1. Resolve the storage repo (env / config); if disabled → inject nothing, `exit 0`.
2. Ensure the checkout: clone once (synchronous), then refresh in the
   **background** (`pull --ff-only`) so startup never blocks (this session uses
   the last synced copy; the next sees the update).
3. **Reconcile this project's symlinks:** for each
   `checkout/<org>/<repo>/memory/*.md`, ensure a symlink in the native dir; prune
   dangling links into the checkout; **never touch real files**; if the native dir
   already has a real file with the same name as a team file → flag as a semantic
   conflict (see §9), don't overwrite it.
4. Inject a **freshly derived index** (from each file's `name`/`description`
   frontmatter; fall back to the first `#` heading / filename) as
   `- [Title](slug.md) — hook`, with a preamble (team-shared / don't re-save
   locally / don't re-share / verify before relying / on conflict prefer
   the newer & more specific). **Bodies are not injected** — symlinks + native
   recall handle them (no token cost, no size cap).
5. **Graceful degrade:** if the native dir can't be located, skip symlinking but
   still inject the index (discoverability preserved; bodies readable from the
   checkout path).

To inject, `load.mjs` prints **exactly one** JSON object to stdout —
`{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"<text>"}}`
— or **nothing** when there is nothing to inject. stdout is reserved for that one
object; all diagnostics go to stderr (`ctmLog`). The whole entry is wrapped in
try/catch and **always exits 0**: fail-soft throughout, never blocks session start.

## 7. Publish (`/share-memory` skill; manual in v1)

The skill (Claude) is the **reasoning** half (classify → sanitize → merge →
confirm); the git **mechanics** are `scripts/publish.mjs` (the bundle of
`src/bin/publish.ts` → `src/publish.ts`), invoked as
`node "$CLAUDE_PLUGIN_ROOT/scripts/publish.mjs" --checkout-dir … --target-dir … [--native-dir …] --slug <foo.md> …`.

1. Resolve paths — key (`<org>/<repo>`) / checkout / target / native — via the
   plugin's resolver (`src/resolve.ts`, surfaced by `/team-memory status`); the
   resolver clones the checkout once if absent (it does not pull; `publish.mjs`
   rebases onto upstream before pushing).
2. Read the native dir's real files (skip ones that are already symlinks — those
   are already team); classify; skip personal.
3. For each team file: read the existing same-slug file in the checkout →
   sanitize → if diverged, **semantically merge (don't clobber others'
   additions)** → write to `checkout/<org>/<repo>/memory/<slug>.md`; skip if
   byte-identical (dedupe, no churn).
4. **Publish never deletes from the checkout.** Local absence is *not* authority to
   delete — a file can be missing because reconcile degraded, was never loaded, or
   belongs to a teammate. Removing shared memory is an explicit
   `/team-memory unshare <slug>` action that checks ownership / writes a tombstone
   before deleting, so publish can never silently erase teammate-authored memory.
5. No `MEMORY.md` is written (the index is derived at load time).
6. Show a **review summary** (what will be shared / kept personal / redactions /
   merges) and wait for explicit confirmation.
7. `publish.mjs`: stage exactly the named slug paths (exact path args, never
   `git add -A`, never `git rm`) → commit only those pathspecs → `git pull --rebase`
   → push (bounded retry on races); on conflict it aborts the rebase cleanly and
   Claude resolves (§9) then re-runs. **Never force-push.** (The shared
   pull-rebase-push helper `pushWithRebase` in `lib/git.ts` is reused by unshare.)
8. **After a successful push, convert a published local file to a symlink only if
   its content is byte-identical to the pushed copy.** If sanitization or a merge
   changed the shared copy, **keep the local real file as-is** (no data loss); the
   skill offers to split the redacted / local-only part into a `personal` memory so
   nothing sensitive is lost *or* shared. If push failed, keep the real file and report.

## 8. Deduplication & anti-circular

1. **Slug = filename → upsert, not append.** The same fact reuses the same slug;
   byte-identical content is not rewritten. Re-running never produces `foo-2.md`.
2. **Load is read-only into context and never writes memory; publish is the only
   writer** → structurally breaks the load → save-locally → re-publish loop.
3. **Provenance.** The injected preamble says "don't re-save / re-share";
   team-origin files carry `metadata.origin: team` and publish excludes them;
   symlinked-in files are inherently team and aren't treated as new local work.
4. **Self-reference guard** (§3): storage URL == current project's `origin`, or
   cwd inside a plugin-data checkout → fully disabled.
5. **Single physical copy** (checkout) + local symlink → there are never two real
   copies → no in-context duplication (so the symlink model needs no "dedupe on
   load" step at all).
6. **No implicit deletion** (§7.4): shared storage is only removed via an explicit,
   ownership-checked `/team-memory unshare`.

## 9. Conflict resolution (Claude resolves it)

- **Git-level** (someone pushed first): publish always `pull --rebase` before
  push. On conflict, Claude reads both sides of each fact file and **merges them
  into one coherent fact** (union; newer supersedes stale; keep compatible
  nuances); the index is re-derived (never hand-merged); continue the rebase →
  push; on a re-race, re-pull and retry (bounded). **Never force-push, never drop
  others' content.**
- **Semantic** (a team fact contradicts a local one): at load, the preamble tells
  Claude to prefer the newer/more specific and flag it; at publish, compare the
  same slug before writing — if diverged, merge/supersede into one reconciled
  fact (optionally with an `updated YYYY-MM-DD:` trail) rather than blindly
  overwriting.
- **Real-vs-team name clash** (you have an unpublished `foo.md`, a teammate
  published `foo.md`): don't overwrite the real file with a symlink — flag it as
  a semantic conflict for Claude to reconcile.

## 10. Plugin structure (Node / TypeScript)

The plugin is implemented in **TypeScript** and built to **zero-runtime-dependency
ESM** with esbuild. Two trees, kept distinct:

- **`plugin/`** — the *installable* plugin. This is the only thing a user's Claude
  Code runs. It contains the manifest, hook wiring, the skills, and the **built**
  `scripts/*.mjs` (committed, so installing needs no build step).
- **`src/`** — the TypeScript we author. The hook/skill entry points live in
  `src/bin/` and are bundled by esbuild into `plugin/scripts/*.mjs`. **Never
  hand-edit `plugin/scripts/*.mjs`** — they are build outputs.

```
claude-team-mem/                          (eng-dot-md/claude-team-mem)
├─ .claude-plugin/
│   └─ marketplace.json                   single-plugin marketplace; "source": "./plugin"
├─ plugin/                                 ← the installable plugin (what ships)
│   ├─ .claude-plugin/plugin.json          name / version / description / author
│   ├─ hooks/hooks.json                    SessionStart → node scripts/load.mjs  [v2: Stop → auto-publish]
│   ├─ skills/
│   │   ├─ share-memory/SKILL.md           classify → sanitize → upsert → merge → invoke publish.mjs
│   │   └─ team-memory/SKILL.md            manage config / status / sync / unshare (invokes unshare.mjs)
│   └─ scripts/                            ← BUILT by esbuild from src/bin/ (committed; do not hand-edit)
│       ├─ load.mjs                        SessionStart entry  (from src/bin/load.ts)
│       ├─ publish.mjs                     publish mechanics   (from src/bin/publish.ts)
│       └─ unshare.mjs                     unshare mechanics   (from src/bin/unshare.ts)
├─ src/                                     ← the TypeScript we author
│   ├─ bin/{load,publish,unshare}.ts       thin CLI entry points (argv/stdin parse → core; emit JSON)
│   ├─ {load,publish,unshare}.ts           core flows (the SessionStart load, publish + unshare mechanics)
│   ├─ resolve.ts                          env/config → storage URL; anti-circular guard; clone-once; derive paths
│   ├─ types.ts                            shared interfaces (Resolution, ParsedRemote, Memory, Config)
│   └─ lib/
│       ├─ git.ts                          execFileSync('git', argsArray); cloneOnce; ensureIdentity; pushWithRebase
│       ├─ remote.ts                       parse remote → {host, owner, repo}; sameRepo; autoStorageUrl
│       ├─ paths.ts                        dataDir; configPath; checkout dir from URL; project key; native-dir slug
│       ├─ config.ts                       read/write <dataDir>/config.json (fail-soft defaults)
│       ├─ frontmatter.ts                  minimal YAML-frontmatter parser; readMemory; isValidSlug
│       ├─ guard.ts                        isCircular (storage == origin, or cwd inside a checkout)
│       └─ log.ts                          ctmLog → stderr (stdout is reserved for hook JSON)
├─ scripts/build.mjs                       esbuild: src/bin/*.ts → plugin/scripts/*.mjs (esm, node, bundled)
├─ tests/{lib,e2e}.test.ts                 node:test — pure-logic units + offline end-to-end on the built .mjs
├─ package.json                            type:module; scripts: build / typecheck / test; devDeps only
├─ tsconfig.json                           strict + noUncheckedIndexedAccess + verbatimModuleSyntax
├─ DESIGN.md
└─ README.md
```

- **Build / check / test (pnpm):** `pnpm build` runs `scripts/build.mjs` (esbuild)
  to bundle `src/bin/{load,publish,unshare}.ts` → `plugin/scripts/{load,publish,unshare}.mjs`
  (ESM, `platform: node`, bundled, **no runtime deps**). `pnpm typecheck` is
  `tsc --noEmit`. `pnpm test` runs `node --import tsx --test tests/*.test.ts`.
- **Entry points run under `node`.** The SessionStart hook and the skills invoke
  the built scripts as `node "$CLAUDE_PLUGIN_ROOT/scripts/<name>.mjs"`; `${CLAUDE_PLUGIN_ROOT}`
  self-locates the installed `plugin/` dir.
- **Data dir** is `${CLAUDE_PLUGIN_DATA}` (provided by Claude Code; **default
  `~/.claude-team-mem`** when unset), the single home for both checkouts
  (`${CLAUDE_PLUGIN_DATA}/repos/<storage-id>/`) and the **config**
  (`${CLAUDE_PLUGIN_DATA}/config.json`, one canonical location).
- **All git** goes through `lib/git.ts` → `execFileSync('git', [args…])` (an args
  array, never a shell string) so slugs/paths are never glob-expanded or
  word-split. Everything is **fail-soft**; the SessionStart load never throws and
  never blocks. Target runtime: **Node ≥ 20** on macOS / darwin.

## 11. Caveats (validate / handle during implementation)

1. **Whether a symlinked file participates in native recall** (via its frontmatter
   `description`) is not clearly documented → keep index injection as the floor
   (discoverability never lost; bodies readable from the checkout).
2. **The native memory dir is keyed by a slug of the repo-root path** (a Claude
   Code implementation detail): the project's absolute root path with every `/`
   and `.` replaced by `-`, under `<base>/projects/<slug>/memory/`, where `<base>`
   is `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`. (e.g.
   `/Users/u/ws/app` → `<base>/projects/-Users-u-ws-app/memory/`.) Pin + test the
   derivation; if it fails, inject only and skip symlinking (degrade gracefully).
3. Editing a symlinked memory edits the (uncommitted) file in the checkout.
4. Dangling symlinks (plugin-data cleared / plugin uninstalled) → pruned at load.
5. consolidate-memory and similar operations write through symlinks to the checkout.
6. Windows symlinks are weak (the team is on darwin — fine).

## 12. Build plan

**v1 (plugin MVP)** — implemented in Node/TypeScript (built to `plugin/scripts/*.mjs`).
1. Plugin scaffold + toolchain: `.claude-plugin/marketplace.json` (`source: ./plugin`),
   `plugin/.claude-plugin/plugin.json`, `package.json` / `tsconfig.json` /
   `scripts/build.mjs` (esbuild), `README.md`.
2. `src/lib/` + `src/resolve.ts`: env → config → disabled resolution
   (`remote.ts` host/owner/protocol parsing), circular guard (`guard.ts`), checkout
   keyed by storage-repo identity under `${CLAUDE_PLUGIN_DATA}/repos/` (`paths.ts`),
   config at `${CLAUDE_PLUGIN_DATA}/config.json` (`config.ts`; `CLAUDE_PLUGIN_DATA`
   defaults to `~/.claude-team-mem`). All git via `lib/git.ts` (args-array, fail-soft).
3. `src/load.ts` + `src/bin/load.ts` (→ `load.mjs`) + `plugin/hooks/hooks.json`:
   SessionStart background-pull + symlink reconcile + index injection.
4. `plugin/skills/share-memory` + `src/publish.ts` + `src/bin/publish.ts` (→
   `publish.mjs`): classify / sanitize / upsert / merge / conflict resolution
   (skill) and stage-exact / commit / rebase-push / dedupe / convert-to-symlink
   (only when identical) after push (mechanics).
5. `plugin/skills/team-memory`: manage config (`enable <owner> [repo]` / `list` /
   `status` / `sync`) and **`unshare <slug>`** (ownership check + tombstone — the
   only deleter; mechanics in `src/unshare.ts` → `unshare.mjs`).
6. Migrate the interim `.claude/` prototype files (skill + hook + config) into the
   plugin; revert the interim `.claude/settings.json` SessionStart edit; drop the
   interim `team-memory.json`.
7. Isolated end-to-end test (`tests/e2e.test.ts`, `node:test`): drive the built
   `plugin/scripts/*.mjs` against a bare local "remote" with an isolated
   `HOME`/`CLAUDE_PLUGIN_DATA` (fully offline — no network / org touched).

**v2 (automation & polish)**
- `Stop` hook to auto-publish (mirrors the existing CLAUDE.md-audit Stop hook),
  with a gate.
- Write `metadata.scope` at memory-creation time.
- Flesh out `/team-memory status / unshare / sync`.
- Optional: CI-generated human-readable README overview of the storage repo.

## 13. Setup (one-time)

1. Create a private storage repo for the team, e.g. `<your-org>/claude-team-memory`
   (one repo can serve several orgs — see §3).
2. Configure `${CLAUDE_PLUGIN_DATA}/config.json` (default `~/.claude-team-mem/config.json`),
   e.g. `"owners": { "<your-org>": "auto" }`.
3. Install + enable the plugin; ensure `git` and **`node` (≥ 20)** are on PATH
   (the entry points run under `node`; no other runtime deps). The `/team-memory`
   skill uses `jq` for config edits when present and falls back to editing the JSON
   directly when it is not.
