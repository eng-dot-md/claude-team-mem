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

- **macOS / darwin.** Scripts target `/bin/bash` 3.2 (the version shipped with
  macOS); symlink-based loading assumes a POSIX filesystem.
- **`git`** on `PATH` (transport + store).
- **`jq`** on `PATH` (config and JSON handling). `python3` is also used where
  available.

## Install

Add this repository as a Claude Code marketplace, then install the plugin:

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

3. **Ensure the toolchain.** `git` and `jq` (or `python3`) on `PATH`.

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
├─ .claude-plugin/{plugin.json, marketplace.json}   manifest + marketplace
├─ hooks/hooks.json                                  SessionStart → load
├─ skills/
│   ├─ share-memory/SKILL.md                         classify → sanitize → publish
│   └─ team-memory/SKILL.md                          config / status / sync / unshare
├─ scripts/{lib.sh, resolve-repo.sh, load.sh, publish.sh, unshare.sh}
├─ DESIGN.md
└─ README.md
```

## License

MIT.
