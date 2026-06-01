# claude-team-mem

A lightweight [Claude Code](https://claude.com/claude-code) plugin that shares a
team-relevant subset of Claude's per-project memory across a team. It is built
**on top of** Claude's native file-based memory, not as a replacement: native
memory stays the authoring and recall engine, and the plugin is a thin **git
sync layer** — classify → publish → load — keyed per project (`<org>/<repo>`) and
per team. Git is the transport, the store, and the merge model; there is no
server and no database. Sharing is **explicit opt-in** (only GitHub owners you
list in config participate), the storage repo is **private**, the team path
always sanitizes, and duplicate/circular creation and implicit deletion are
prevented structurally. See [`DESIGN.md`](./DESIGN.md) for the full design.

## How it works (one screen)

- A **storage repo** (private, one per team — it can serve several GitHub orgs)
  holds the actual shared memory, one subtree per project keyed `<org>/<repo>`.
  The **plugin repo** (this one) holds only code.
- On **session start**, the plugin resolves the storage repo for the current
  project (by the project owner, via config), clones/refreshes a local checkout,
  symlinks each shared memory file into Claude's native memory dir, and injects a
  freshly derived index. The real bytes live in the checkout exactly once; the
  native dir holds symlinks — so there is a single physical copy and no
  in-context duplication.
- You **publish** with `/share-memory` (classify → sanitize → upsert → merge →
  push). Publish never deletes. Removing a shared memory is the explicit,
  ownership-checked `/team-memory unshare <slug>`.

```
  local, per machine                          Storage repo (private, per team)
  native memory + plugin's symlink layer  ──publish──▶  <org>/<repo>/memory/<slug>.md
                                          ◀───load───   (the only physical copy lives here)
```

## Requirements

- **macOS / darwin.** Symlink-based loading assumes a POSIX filesystem (the team
  is on darwin).
- **Node ≥ 20** on `PATH`. The plugin is TypeScript built to zero-runtime-dependency
  ESM; the SessionStart hook and the skills run the bundled scripts under `node`.
- **`git`** on `PATH` (transport + store). Every git call goes through an args
  array (`execFileSync('git', […])`), never a shell string.

> The installed plugin needs **no build step and no `node_modules`** — the
> `plugin/scripts/*.mjs` it runs are committed build outputs. Node and the dev
> toolchain (pnpm, esbuild, tsx) are only needed to *develop* the plugin (see
> [Development](#development)).

## Install

Add this repository as a Claude Code marketplace, then install the plugin. The
marketplace manifest points at the `plugin/` subdirectory (`"source": "./plugin"`),
so installing pulls only the installable plugin:

```
/plugin marketplace add eng-dot-md/claude-team-mem
/plugin install claude-team-mem@claude-team-mem
```

(The marketplace and the plugin are both named `claude-team-mem`.) You can also
point the marketplace at a local clone during development:

```
/plugin marketplace add /path/to/claude-team-mem
```

## One-time setup

Follow [`DESIGN.md` §13](./DESIGN.md):

1. **Create a private storage repo** for your team, e.g.
   `<your-org>/claude-team-memory`. One repo can serve several orgs (entries are
   keyed `<org>/<repo>`, so `acme/app` and `globex/app` never collide).

2. **Configure the owner → storage mapping.** Config lives at
   `$CLAUDE_PLUGIN_DATA/config.json` (when `CLAUDE_PLUGIN_DATA` is unset it
   defaults to `~/.claude-team-mem`, so the default path is
   `~/.claude-team-mem/config.json`). The easiest way is the skill:

   ```
   /team-memory enable <your-org>            # stores "auto"
   ```

   which writes:

   ```json
   {
     "owners": {
       "<your-org>": "auto"
     }
   }
   ```

   `"auto"` resolves to `<your-org>/claude-team-memory` on the same host and
   protocol as the project's `origin`. You can also map to an explicit
   `owner/repo` or a full git URL (`/team-memory enable <org> someorg/somerepo`),
   and point several orgs at one repo for a multi-org team. **Owners you do not
   list are no-ops** — repos you merely cloned (open source, forks, …) are never
   touched.

   You can also edit the config file directly instead of using the skill. It is a
   small JSON document at `$CLAUDE_PLUGIN_DATA/config.json`:

   ```json
   {
     "owners": { "<your-org>": "auto" },
     "maxIndexBytes": 20000
   }
   ```

   `maxIndexBytes` (optional, default `20000`; `0` = uncapped) bounds the index
   injected at session start.

3. **Ensure the toolchain.** `git` and **`node` (≥ 20)** on `PATH`. (The
   `/team-memory` skill uses `jq` for config edits when present and falls back to
   editing the JSON directly when it is not.)

> Per-project override: set `CLAUDE_TEAM_MEMORY_REPO` (a full git URL or
> `owner/repo`) in your environment to override config for the repo you are in.

## Usage

Once an owner is configured, day-to-day use is three things:

- **Automatic load (SessionStart).** Nothing to run. When you start a session in
  a repo owned by a configured org, the plugin clones/refreshes the checkout,
  reconciles symlinks into the native memory dir, and injects the team index. It
  is fail-soft and never blocks startup; if the native dir can't be located it
  still injects the index (bodies remain readable from the checkout).

- **`/share-memory`** — publish team-relevant memory. It classifies personal vs
  team (frontmatter `metadata.scope`, falling back to content; **when unsure →
  personal**), sanitizes (strips secrets/tokens/auth URLs and anything your
  `CLAUDE.md` forbids), upserts by slug (no duplicates, no churn), merges
  divergent copies instead of clobbering teammates' edits, shows a review summary
  for confirmation, then `pull --rebase` → commit → push (never force-push).
  After a successful push it converts a published local file to a symlink **only
  when the bytes are identical**; otherwise it keeps your local file so nothing
  is lost.

- **`/team-memory`** — manage config and lifecycle:

  | Command | What it does |
  |---|---|
  | `enable <owner> [repo\|auto]` | Map a GitHub owner → storage repo (the opt-in switch). |
  | `list` | Show configured owners and how each resolves. |
  | `status` | This project: enabled? storage repo, checkout path, # team files, conflicts. |
  | `sync` | `git pull --ff-only` the current checkout on demand. |
  | `unshare <slug>` | Remove a shared memory (writes a tombstone) — **the only deleter**. |

## Safety model (why it won't surprise you)

- **Opt-in only** — unlisted owners no-op; nothing is shared from a repo you
  didn't configure.
- **No circular creation** — if the resolved storage repo equals the project's
  own `origin`, or you are working inside a plugin-data checkout, the plugin
  disables itself.
- **No implicit deletion** — `/share-memory` never deletes from storage; only
  `/team-memory unshare` removes a shared file, and only after an ownership /
  confirmation check, writing an auditable tombstone and never force-pushing.
- **Sanitize always** — even though the storage repo is private.

## Layout

```
claude-team-mem/
├─ .claude-plugin/marketplace.json          single-plugin marketplace ("source": "./plugin")
├─ plugin/                                   the installable plugin (what ships)
│   ├─ .claude-plugin/plugin.json            manifest
│   ├─ hooks/hooks.json                       SessionStart → node scripts/load.mjs
│   ├─ skills/
│   │   ├─ share-memory/SKILL.md              classify → sanitize → merge → publish
│   │   └─ team-memory/SKILL.md               config / status / sync / unshare
│   └─ scripts/{load,publish,unshare,resolve}.mjs  BUILT from src/bin/ (committed; do not hand-edit)
├─ src/                                       the TypeScript we author
│   ├─ bin/{load,publish,unshare,resolve}.ts  CLI entry points (bundled into plugin/scripts/)
│   ├─ {load,publish,unshare,resolve,types}.ts core flows + shared types
│   └─ lib/{git,remote,paths,config,frontmatter,guard,log}.ts
├─ scripts/build.mjs                          esbuild bundler (src/bin → plugin/scripts)
├─ tests/{lib,e2e}.test.ts                    node:test (units + offline end-to-end)
├─ package.json · tsconfig.json
├─ DESIGN.md
└─ README.md
```

See [`DESIGN.md` §10](./DESIGN.md) for the full structure and the rationale for
the `src/` (authored) vs `plugin/` (shipped) split.

## Development

The plugin is **TypeScript** built to zero-runtime-dependency ESM with esbuild,
using **pnpm**. Authored code lives in `src/`; the build emits the committed
`plugin/scripts/*.mjs` the installed plugin runs.

```bash
pnpm install --ignore-scripts   # dev toolchain only (esbuild, tsx, typescript); no runtime deps
pnpm build        # esbuild: src/bin/{load,publish,unshare,resolve}.ts → plugin/scripts/*.mjs
pnpm typecheck    # tsc --noEmit (strict, noUncheckedIndexedAccess, verbatimModuleSyntax)
pnpm test         # builds first, then node:test (units + offline end-to-end)
```

> Use `--ignore-scripts` on install: the only dependency postinstall is esbuild's,
> which is unnecessary (its platform binary ships in the `@esbuild/<platform>`
> optional dependency), and pnpm 11+ otherwise fails the install with
> `ERR_PNPM_IGNORED_BUILDS`. Explicit `pnpm run` scripts (build/test) are unaffected.

Notes:

- **Never hand-edit `plugin/scripts/*.mjs`** — they are build outputs. Edit the
  TypeScript in `src/` and re-run `pnpm build`. The `.mjs` are committed so the
  installed plugin runs with no build step or `node_modules`.
- The test suite is fully **offline**: `tests/e2e.test.ts` drives the built
  `plugin/scripts/*.mjs` against a bare local git "remote" in an isolated
  `HOME`/`CLAUDE_PLUGIN_DATA` (no network, no real org touched).
- To try it against a local checkout of Claude Code, point the marketplace at the
  repo: `/plugin marketplace add /path/to/claude-team-mem` (the manifest's
  `"source": "./plugin"` resolves the installable subtree).

## CI & Releases

- **CI** (`.github/workflows/ci.yml`) runs on every PR and push to `main`: install
  → typecheck → build → verify the committed `plugin/scripts/*.mjs` match a fresh
  build → test.
- **Releases** (`.github/workflows/release.yml`) are cut manually: Actions →
  **Release** → *Run workflow*, then choose a `patch` / `minor` / `major` bump (or
  pass an explicit `version`). It re-runs the full gate, bumps the version across
  `package.json`, `plugin/.claude-plugin/plugin.json`, and
  `.claude-plugin/marketplace.json`, commits + tags `vX.Y.Z`, publishes the
  unscoped `claude-team-mem` package to **npm** (`pnpm publish`), and publishes a
  **GitHub Release** with auto-generated notes.
- **Publishing is tokenless** — `pnpm publish` uses npm **Trusted Publishing
  (OIDC)**: the job has `id-token: write` and pnpm fetches a short-lived credential
  via OIDC, attaching provenance automatically. There is **no `NPM_TOKEN`**.
  (Requires pnpm ≥ 11.0.9 for the OIDC fix — pinned `11.5.0` via `packageManager`.)
  **One-time setup, required before the first release:** on npmjs.com add a
  **Trusted Publisher** for the `claude-team-mem` package → GitHub repo
  `eng-dot-md/claude-team-mem`, workflow `release.yml`. The npm tarball is just the
  installable `plugin/` subtree (+ docs); Claude Code itself still installs via the
  marketplace git `source: ./plugin`.

## License

MIT.
