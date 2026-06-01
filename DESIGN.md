# claude-team-memory — Design

A lightweight Claude Code plugin that shares a team-relevant subset of Claude's
per-project memory across a team. It is built **on top of** Claude's native
file-based memory, not as a replacement.

> Status: design spec. The plugin is built per §12 (Build plan).

## 1. Goals & principles

- **Build on native memory.** Native memory stays the authoring + recall engine.
  The plugin is only a thin **git sync layer** — classify → publish → load —
  organized per project and per owner.
- **Lightweight.** Git is the transport, the store, and the merge model. No
  server, no database.
- **Explicit opt-in.** The plugin activates only for GitHub owners listed in a
  config — not for every repo. Repos you merely cloned (open source, forks, …)
  are never touched.
- **Safe.** The storage repo is private; the team path always sanitizes;
  duplicate and circular creation are prevented structurally; conflicts
  auto-resolve.

## 2. Two repos — keep them distinct (the basis for "no circular creation")

| Role | Repo | Holds | Lifecycle |
|---|---|---|---|
| **Plugin** (the tool) | `eng-dot-md/claude-team-memory` | code only: hooks / skills / scripts | installed via marketplace |
| **Storage** (the data) | configured per owner | the actual memory, one subdirectory per project | created once per GitHub owner |

```
          classify / publish ▲            ▼ load (symlink + inject index)
 ┌────────── local, per machine ────────┐  ┌─── Storage repo (private, per owner) ──┐
 │ native memory + plugin's symlink layer│←→│ <project>/memory/<slug>.md             │
 └───────────────────────────────────────┘  │ (the only physical copy lives here)    │
                                             └────────────────────────────────────────┘
```

## 3. Resolution: owner → storage repo (config-driven)

For whatever project you are in, resolve its storage repo in this order:

1. **Env var `CLAUDE_TEAM_MEMORY_REPO`** (full git URL or `owner/repo`) — a
   per-project override.
2. **Config lookup by owner** (parse host + owner + protocol from the project's
   `origin` remote):
   - hit → use the mapped value (`"auto"` = `<host>:<owner>/claude-team-memory`,
     or an explicit `owner/repo` / full git URL);
   - miss → **disabled; the plugin no-ops for that repo.**
3. **Anti-circular guard** on top: if the resolved storage repo *is* the current
   project (storage == current repo / project key == storage repo name / cwd is
   inside the plugin-data checkout) → disabled.

- **Project key** (subdirectory) = the project repo basename → `app/`,
  `lib/`, `infra/`.
- **Local checkout**: `${CLAUDE_PLUGIN_DATA}/repos/<host>__<owner>/` — one per
  owner, so you can work across orgs on one machine.

**Config** `~/.claude/claude-team-memory.json` (user-level; manageable via the
`/team-memory` skill):

```json
{
  "owners": {
    "acme": "auto",
    "globex": "git@github.com:globex/shared-claude-mem.git"
  },
  "maxIndexBytes": 20000
}
```

"Enabling an owner" = adding a line to `owners`. With `"acme": "auto"`, a
project at `acme/<repo>` resolves to the storage repo `acme/claude-team-memory`.

## 4. Local layout — shared memory lives as symlinks in the native dir

```
~/.claude/projects/<repo-hash>/memory/         ← native memory dir for this project
├─ my-personal.md          real file · personal · never leaves the machine
├─ unpublished-idea.md     real file · not yet published
├─ foo.md            ──┐   symlink → one you published
└─ teammate-bar.md ──┐ │   symlink → one a teammate shared
                     │ │
${CLAUDE_PLUGIN_DATA}/repos/github__acme/       ← clone of the storage repo (real bytes here)
└─ app/memory/{foo.md, teammate-bar.md}    ◄──┘
```

**Core idea:** the real bytes for a shared fact live in the checkout exactly
once; the native dir holds a **symlink** to it. Consequences:

- **Local is not deleted** — on publish, the local real file is converted to a
  symlink.
- **No duplication** — a fact has a single physical copy, so it can never appear
  twice in context.
- **Native recall is preserved** — the native memory system follows symlinks.
- **Offline fallback** — the checkout is a local cache; shared memory is still
  readable offline.

So the native dir = `{real files: personal / unpublished memory}` ∪
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

## 6. Load (SessionStart, `command` hook)

1. Resolve the storage repo (env / config); if disabled → `exit 0`.
2. Ensure the checkout: clone once (synchronous), then refresh in the
   **background** (`pull --ff-only`) so startup never blocks (this session uses
   the last synced copy; the next sees the update).
3. **Reconcile this project's symlinks:** for each `checkout/<key>/memory/*.md`,
   ensure a symlink in the native dir; prune dangling links into the checkout;
   **never touch real files**; if the native dir already has a real file with the
   same name as a team file → flag as a semantic conflict (see §9).
4. Inject a **freshly derived index** (from each file's `name`/`description`
   frontmatter; fall back to the first `#` heading / filename) as
   `- [Title](slug.md) — hook`, with a preamble (team-shared / don't re-save
   locally / don't re-share / verify before relying / on conflict prefer
   the newer & more specific). **Bodies are not injected** — symlinks + native
   recall handle them (no token cost, no size cap).
5. **Graceful degrade:** if the native dir can't be located, skip symlinking but
   still inject the index (discoverability preserved; bodies readable from the
   checkout path).

Fail-soft throughout; never blocks session start.

## 7. Publish (`/share-memory` skill; manual in v1)

1. `resolve-repo.sh` → key / checkout / target / native paths; pull first.
2. Read the native dir's real files (skip ones that are already symlinks — those
   are already team); classify; skip personal.
3. For each team file: read the existing same-slug file in the checkout →
   sanitize → if diverged, **semantically merge (don't clobber others'
   additions)** → write to `checkout/<key>/memory/<slug>.md`; skip if
   byte-identical (dedupe, no churn).
4. Remove from the checkout any file that is now personal/deleted locally.
5. No `MEMORY.md` is written (the index is derived at load time).
6. Show a **review summary** (what will be shared / kept personal / redactions /
   merges) and wait for explicit confirmation.
7. `publish.sh`: `git pull --rebase` → on conflict, Claude resolves (§9) →
   commit → push (bounded retry on races). **Never force-push.**
8. **After a successful push**, convert each published local real file into a
   symlink to the checkout copy; if push failed, keep the real file (no data
   loss) and report.

## 8. Deduplication & anti-circular

1. **Slug = filename → upsert, not append.** The same fact reuses the same slug;
   byte-identical content is not rewritten. Re-running never produces `foo-2.md`.
2. **Load is read-only into context and never writes memory; publish is the only
   writer** → structurally breaks the load → save-locally → re-publish loop.
3. **Provenance.** The injected preamble says "don't re-save / re-share";
   team-origin files carry `metadata.origin: team` and publish excludes them;
   symlinked-in files are inherently team and aren't treated as new local work.
4. **Self-reference guard** (§3): storage == current / key == storage name / cwd
   inside plugin-data → fully disabled.
5. **Single physical copy** (checkout) + local symlink → there are never two real
   copies → no in-context duplication (so the symlink model needs no "dedupe on
   load" step at all).

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

## 10. Plugin structure

```
claude-team-memory/                       (eng-dot-md/claude-team-memory)
├─ .claude-plugin/
│   ├─ plugin.json                        name / version / description / author
│   └─ marketplace.json                   so it installs as a marketplace
├─ hooks/hooks.json                       SessionStart → load   [v2: Stop → auto-publish]
├─ skills/
│   ├─ share-memory/SKILL.md              classify → sanitize → upsert → resolve → publish
│   └─ team-memory/SKILL.md               manage config / status / sync / unshare
├─ scripts/
│   ├─ lib.sh                             parse remote→host/owner/name; JSON i/o; checkout path; circular guard; native-dir location
│   ├─ resolve-repo.sh                    env/config resolution; clone/pull; print key + paths
│   ├─ load.sh                            SessionStart: resolve + bg-pull + symlink reconcile + inject derived index
│   └─ publish.sh                         pull --rebase / commit / push / retry
└─ README.md
```

Scripts use `${CLAUDE_PLUGIN_ROOT}` to self-locate and `${CLAUDE_PLUGIN_DATA}` for
the checkout + config; macOS bash 3.2 compatible; jq or python3 for JSON;
fail-soft.

## 11. Caveats (validate / handle during implementation)

1. **Whether a symlinked file participates in native recall** (via its frontmatter
   `description`) is not clearly documented → keep index injection as the floor
   (discoverability never lost; bodies readable from the checkout).
2. **The native memory dir is keyed by a hash of the repo-root path** (a Claude
   Code implementation detail) → pin + test the derivation; if it fails, inject
   only and skip symlinking (degrade gracefully).
3. Editing a symlinked memory edits the (uncommitted) file in the checkout.
4. Dangling symlinks (plugin-data cleared / plugin uninstalled) → pruned at load.
5. consolidate-memory and similar operations write through symlinks to the checkout.
6. Windows symlinks are weak (the team is on darwin — fine).

## 12. Build plan

**v1 (plugin MVP)**
1. Plugin scaffold (`plugin.json` / `marketplace.json` / `README.md`).
2. `lib.sh` + `resolve-repo.sh`: env → config → disabled resolution,
   host/owner/protocol parsing, circular guard, checkout + config under
   `${CLAUDE_PLUGIN_DATA}`.
3. `load.sh` + `hooks/hooks.json`: SessionStart symlink reconcile + index injection.
4. `skills/share-memory` + `publish.sh`: classify / sanitize / upsert / merge /
   conflict resolution / dedupe / convert-to-symlink after push.
5. `skills/team-memory`: manage config (`enable <owner> [repo]` / list / status / sync).
6. Migrate the interim `.claude/` prototype files (skill + hook + config) into the
   plugin; revert the interim `.claude/settings.json` SessionStart edit; drop the
   interim `team-memory.json`.
7. Isolated end-to-end test: throwaway storage repo + isolated `HOME`/`PLUGIN_DATA`
   (no network / org touched).

**v2 (automation & polish)**
- `Stop` hook to auto-publish (mirrors the existing CLAUDE.md-audit Stop hook),
  with a gate.
- Write `metadata.scope` at memory-creation time.
- Flesh out `/team-memory status / unshare / sync`.
- Optional: CI-generated human-readable README overview of the storage repo.

## 13. Dogfood setup (one-time)

1. Create a private `<your-org>/claude-team-memory`.
2. Configure `~/.claude/claude-team-memory.json` with `"owners": { "<your-org>": "auto" }`.
3. Install + enable the plugin; ensure `git` + `jq` (or python3) are on PATH.
