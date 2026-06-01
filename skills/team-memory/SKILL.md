---
name: team-memory
description: Manage claude-team-mem — configure which GitHub owners share memory, inspect the current project's team-memory status, sync the local checkout, and unshare (delete) a shared memory. Use when the user runs /team-memory, asks to enable/configure team memory for an org, asks whether this repo is sharing memory or where the shared files live, wants to pull the latest team memory, or wants to remove/unshare/delete a shared team memory.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash(git *)
  - Bash(jq *)
  - Bash(ls *)
  - Bash(cat *)
  - Bash(mkdir *)
  - Bash(printf *)
  - Bash("$CLAUDE_PLUGIN_ROOT"/scripts/*)
  - Bash(bash "$CLAUDE_PLUGIN_ROOT"/scripts/*)
---

# /team-memory — manage team memory config & lifecycle

This skill manages the **config and lifecycle** of `claude-team-mem` (see
`DESIGN.md` §3, §7.4, §8.6, §12, §13). It does **not** publish memory — that is
`/share-memory`. It does **not** load memory — that is the SessionStart hook.

Arguments passed: `$ARGUMENTS`

Throughout, the scripts self-locate via `$CLAUDE_PLUGIN_ROOT`. Always invoke them
by absolute path:

- Resolver (read-only): `bash "$CLAUDE_PLUGIN_ROOT/scripts/resolve-repo.sh"` —
  prints one JSON object for the **current** project (run it from the project
  dir). Keys: `enabled`, `reason`, `storageUrl`, `checkoutDir`, `projectKey`,
  `targetMemoryDir`, `nativeMemoryDir`.
- Config file: `"$CLAUDE_PLUGIN_DATA/config.json"` (when `CLAUDE_PLUGIN_DATA` is
  unset it defaults to `~/.claude-team-mem`, so resolve the real path first —
  step 0 below).
- Deleter (mechanical): `bash "$CLAUDE_PLUGIN_ROOT/scripts/unshare.sh"` — the
  **only** thing that ever removes shared memory.

## Step 0 — resolve the data dir and config path (always do this first)

`CLAUDE_PLUGIN_DATA` may be unset. Resolve the real paths once, using the same
logic as the scripts, and reuse them for the rest of the run:

```bash
DATA_DIR="${CLAUDE_PLUGIN_DATA:-$HOME/.claude-team-mem}"; DATA_DIR="${DATA_DIR%/}"
CONFIG="$DATA_DIR/config.json"
echo "data dir : $DATA_DIR"
echo "config   : $CONFIG"
```

Also confirm the toolchain once and warn (do not abort) if missing:

```bash
command -v git >/dev/null 2>&1 || echo "WARN: git not on PATH — sync/unshare will fail"
command -v jq  >/dev/null 2>&1 || echo "WARN: jq not on PATH — config edits will fail"
```

## Dispatch on the first argument

Parse `$ARGUMENTS`. The first token is the subcommand; the rest are its
operands. Match case-insensitively. If empty, default to **status**. If
unrecognized, print the one-line usage summary at the bottom and stop.

- `enable <owner> [repo|auto]` → **§Enable**
- `list` → **§List**
- `status` (or no args) → **§Status**
- `sync` → **§Sync**
- `unshare <slug>` → **§Unshare**

---

## §Enable — `enable <owner> [repo|auto]`

Map a GitHub **owner** (org or user, exactly the owner segment of a repo's
`origin`) to a storage repo in `config.json`. This is the opt-in switch from
DESIGN §3 / §13: only listed owners ever share memory.

The optional second operand selects the storage repo value to store:

| 2nd operand        | Stored config value      | Resolves to (DESIGN §3)                              |
|--------------------|--------------------------|-----------------------------------------------------|
| omitted, or `auto` | `"auto"`                 | `<owner>/claude-team-memory` on the project host    |
| `someorg/somerepo` | `"someorg/somerepo"`     | that explicit owner/repo on the project host        |
| a full git URL     | the URL verbatim         | that exact repo (any host)                          |

A "full git URL" is anything containing `://` or matching `user@host:owner/repo`
or a local path (`/…`, `./…`, `../…`, `~/…`, `file://…`).

### Procedure

1. **Validate operands.** Require `<owner>`. If absent, print usage for `enable`
   and stop. Let `VALUE` be the second operand, defaulting to `auto`.
2. **Confirm intent.** Show the user exactly what will be written, e.g.
   *"Will set `owners["acme"] = "auto"` in `$CONFIG` (acme repos will share
   memory to acme/claude-team-memory)."* Proceed without a second prompt for a
   plain `auto`; for an explicit repo/URL, echo it back so a typo is visible.
3. **Write the mapping** (atomic; seeds `{}` and creates parent dirs as needed —
   this is exactly `ctm_json_set` semantics):
   ```bash
   mkdir -p "$DATA_DIR"
   [ -f "$CONFIG" ] || printf '{}\n' > "$CONFIG"
   tmp="$CONFIG.tmp.$$"
   jq --arg o "<owner>" --arg v "<VALUE>" '.owners[$o] = $v' "$CONFIG" > "$tmp" \
     && mv "$tmp" "$CONFIG" || { rm -f "$tmp"; echo "FAILED to update $CONFIG"; }
   ```
   Pass `<owner>`/`<VALUE>` as `--arg` (never interpolate into the filter) so odd
   characters can't break the JSON.
4. **Read back and confirm.** `jq '.owners' "$CONFIG"` and show the result.
5. **Tell the user the next step:** the mapping takes effect on the **next**
   session start in a matching repo (the SessionStart hook clones + loads), or
   immediately via `/team-memory sync` from a repo owned by `<owner>`. If they
   have not created the storage repo yet, point them at DESIGN §13 (create a
   private `<owner>/claude-team-memory` first; `auto` will clone it on next
   load).

> To remove an owner mapping, edit `config.json` directly
> (`jq 'del(.owners["<owner>"])'`) — disabling an owner is just config; it never
> touches already-published memory (that is `unshare`).

---

## §List — `list`

Show every configured owner and **how each resolves**.

1. If `$CONFIG` is missing or has no `.owners`, say so plainly ("No owners
   configured — team memory is disabled for every repo. Run `/team-memory enable
   <owner>`.") and stop.
2. Enumerate owners and their raw values:
   ```bash
   jq -r '.owners // {} | to_entries[] | "\(.key)\t\(.value)"' "$CONFIG"
   ```
3. For each `owner → value`, explain the resolution in one line (no network):
   - `auto` → "→ `<owner>/claude-team-memory` (auto, on the repo's own host)".
   - `owner/repo` → "→ `owner/repo` on the repo's host".
   - full git URL / local path → "→ that repo verbatim: `<value>`".
4. Note any other relevant config keys if present (e.g. `maxIndexBytes`).
5. Remind the user that `CLAUDE_TEAM_MEMORY_REPO` (if set in their environment)
   **overrides** config per project (DESIGN §3 step 1); mention it only if the
   env var is actually set.

Present as a short table or bullet list. Do **not** clone anything here — `list`
is config-only and must not hit the network.

---

## §Status — `status` (default)

Report team-memory state for the **current** project. Run the resolver from the
project directory; it is read-only except that, when enabled, it clones the
checkout **once** if absent (it never pulls).

1. **Resolve:**
   ```bash
   bash "$CLAUDE_PLUGIN_ROOT/scripts/resolve-repo.sh"
   ```
   Parse the single JSON object (use `jq` if available).
2. **If `enabled == false`:** print `Team memory: DISABLED for this project` and
   the `reason` verbatim (e.g. "owner 'x' not configured", "not inside a git
   repository", "project has no origin remote", "circular: …"). If the reason is
   an unconfigured owner, offer the exact fix: `/team-memory enable <owner>`
   (derive `<owner>` from `git remote get-url origin` if possible). Stop.
3. **If `enabled == true`:** report, from the JSON:
   - **Storage repo** — `storageUrl`
   - **Project key** — `projectKey` (the `<org>/<repo>` subtree)
   - **Checkout path** — `checkoutDir`
   - **Team memory dir** — `targetMemoryDir`
   - **Native memory dir** — `nativeMemoryDir`
   - **Resolved via** — `reason`
4. **Count team files** in the checkout subtree (top-level `*.md` only; the
   `.tombstones/` dir is metadata, not memory):
   ```bash
   ls -1 "<targetMemoryDir>"/*.md 2>/dev/null | wc -l | tr -d ' '
   ```
   List a few titles if helpful (read each file's `name:` frontmatter, fall back
   to filename).
5. **Detect conflicts** (DESIGN §6, §9 — "real-vs-team name clash"): for each
   team file `<targetMemoryDir>/<slug>.md`, check whether the **native** dir has
   a **real (non-symlink) file** of the same name. Those are semantic conflicts
   the load hook refuses to overwrite.
   ```bash
   for f in "<targetMemoryDir>"/*.md; do
     [ -e "$f" ] || continue
     b=$(basename "$f"); n="<nativeMemoryDir>/$b"
     if [ -e "$n" ] && [ ! -L "$n" ]; then echo "CONFLICT: $b (local real file shadows the team copy)"; fi
   done
   ```
   Also flag, as a soft warning, any **dangling symlink** in the native dir that
   points into the checkout but whose target no longer exists (a since-unshared
   file); note it is pruned automatically on next load.
   - If `nativeMemoryDir` does not exist, say symlink reconciliation is not
     active for this project (index injection still works — DESIGN §6.5) and skip
     the per-file checks.
6. **Pending local commits in the checkout** (e.g. a prior push failed): if
   `git -C "<checkoutDir>" status --porcelain` is non-empty, or `git -C
   "<checkoutDir>" log --oneline @{u}.. 2>/dev/null` shows unpushed commits,
   surface that and suggest `/team-memory sync`.

Summarize as a compact status block. Never write anything in `status`.

---

## §Sync — `sync`

Manually refresh the current project's checkout (`git pull --ff-only`). The load
hook normally refreshes in the background; this is the on-demand version.

1. **Resolve** (`resolve-repo.sh`). If `enabled == false`, print the reason and
   stop — there is nothing to sync.
2. Let `CK = checkoutDir`. If `"$CK/.git"` is missing, the resolver will already
   have cloned it; if it still isn't there, report the resolver's `reason` and
   stop.
3. **Warn on local divergence first.** If `git -C "$CK" status --porcelain` is
   non-empty (a symlinked memory was edited through the checkout, or a push
   failed mid-flight), tell the user before pulling and let them decide. Do
   **not** stash or discard their changes.
4. **Fast-forward only** (never clobber, never merge-commit, never force):
   ```bash
   git -C "$CK" pull --ff-only --quiet && echo "synced" || echo "could not fast-forward"
   ```
5. If `--ff-only` fails because local commits diverged, explain that local
   commits exist that aren't upstream (likely an unpushed publish/unshare) and
   suggest re-running `/share-memory` or `/team-memory unshare …`, which both
   `pull --rebase` then push. Do not auto-rebase here.
6. Report the post-sync team-file count (same as Status step 4) so the user sees
   what changed.

---

## §Unshare — `unshare <slug>` (THE ONLY DELETER)

Remove a **shared** memory from the storage repo, leaving a tombstone. This is
the single sanctioned deletion path (DESIGN §7.4: *publish never deletes*; §8.6:
*shared storage is only removed via an explicit, ownership-checked unshare*).
You — the skill — own the **ownership / sanity / confirmation** gate;
`unshare.sh` does the mechanical tombstone + `git rm` + commit + push.

### Procedure

1. **Require a slug.** `<slug>` is the memory's file name (with or without
   `.md`). If absent, print usage for `unshare` and stop.
2. **Resolve** (`resolve-repo.sh`). If `enabled == false`, print the reason and
   stop (you cannot unshare from a repo that isn't sharing). Capture
   `checkoutDir`, `targetMemoryDir`, `nativeMemoryDir`, `projectKey`.
3. **Sanity check the file exists** in `targetMemoryDir`:
   ```bash
   ls -l "<targetMemoryDir>/<slug>.md" 2>/dev/null || echo "NOT FOUND"
   ```
   If it isn't there, tell the user it's already gone (it may have been unshared
   by a teammate — check `<targetMemoryDir>/.tombstones/<slug>.md`) and stop.
4. **Refresh first** so the ownership check and the delete are against current
   upstream state: `git -C "<checkoutDir>" pull --ff-only --quiet` (best-effort;
   if it can't ff, warn but you may still proceed — `unshare.sh` does its own
   `pull --rebase` before pushing).
5. **Ownership / sanity check.** Show the user who last authored the file and its
   title, and make clear this affects **everyone** on the team:
   ```bash
   git -C "<checkoutDir>" log -1 --format='%an <%ae>  %ad' --date=short -- "<targetMemoryDir>/<slug>.md"
   ```
   Read the file's frontmatter `name`/`description` and show a short preview of
   the body. Then **confirm explicitly**:
   - If the last author is **not** the current git user
     (`git -C "<checkoutDir>" config user.name` / `user.email`), say so plainly:
     *"This was last authored by <author>, not you. Unsharing removes it for the
     whole team."* Require a clear "yes, unshare it" before proceeding.
   - Ask for / confirm a one-line **reason** to record in the tombstone.
   Never proceed on ambiguity.
6. **Run the deleter** (it writes the tombstone, `git rm`s the file, commits, and
   `pull --rebase` + pushes with bounded retry — never force-pushes):
   ```bash
   bash "$CLAUDE_PLUGIN_ROOT/scripts/unshare.sh" \
     --checkout "<checkoutDir>" \
     --target   "<targetMemoryDir>" \
     --slug     "<slug>" \
     --reason   "<one-line reason>" \
     --by       "<current git user.name>"
   ```
   Interpret the exit code:
   - **0** — removed and pushed. 
   - **3** — file wasn't there (already gone); report and stop.
   - **4** — `pull --rebase` hit a conflict; a teammate changed the repo
     concurrently. Re-run step 4 (refresh) and retry once; if it persists,
     inspect `git -C "<checkoutDir>" status` and resolve before retrying.
   - **5** — committed locally but the push kept failing (network/permissions).
     The removal is committed in the checkout; tell the user to retry with
     `/team-memory sync` or check storage-repo push access. Do **not** re-run
     `unshare.sh` (that would stack a second tombstone commit); just push the
     existing commit once connectivity is back: `git -C "<checkoutDir>" push`.
   - **1 / 2** — input/structural error; show stderr and fix the arguments.
7. **Reconcile the local native dir** (so the now-removed file stops appearing):
   - If `<nativeMemoryDir>/<slug>.md` is a **symlink** into the checkout, it is
     now dangling — remove it: `[ -L "<nativeMemoryDir>/<slug>.md" ] && rm
     "<nativeMemoryDir>/<slug>.md"`. (The next SessionStart load would prune it
     anyway; doing it now keeps the current session clean.)
   - If it is a **real file**, leave it (it was the user's own local copy, not
     team memory) and just note it remains locally.
8. **Confirm** to the user: file removed from `<projectKey>` storage, tombstone
   recorded at `<targetMemoryDir>/.tombstones/<slug>.md`, pushed. Remind them the
   fact should not be re-published without team agreement (the tombstone documents
   the removal; `/share-memory` carries its own provenance guard).

---

## Usage summary (print on bad/empty input where noted)

```
/team-memory enable <owner> [repo|auto]   map an owner → storage repo (opt-in)
/team-memory list                         list configured owners + how each resolves
/team-memory status                       this project: enabled? repo, checkout, #files, conflicts
/team-memory sync                         git pull --ff-only the current checkout
/team-memory unshare <slug>               remove a shared memory (tombstone) — the only deleter
```

Fail-soft: never block the user, never delete anything outside the explicit
`unshare` path, and never force-push.
