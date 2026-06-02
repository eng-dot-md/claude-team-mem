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
  - Bash(node *)
  - Bash(ls *)
  - Bash(cat *)
  - Bash(mkdir *)
  - Bash(printf *)
  - Bash(node "$CLAUDE_PLUGIN_ROOT"/scripts/*)
---

# /team-memory — manage team memory config & lifecycle

This skill manages the **config and lifecycle** of `claude-team-mem` (see
`DESIGN.md` §3, §7.4, §8.6, §12). It does **not** publish memory — that is
`/share-memory`. It does **not** load memory — that is the SessionStart hook
(`node "$CLAUDE_PLUGIN_ROOT/scripts/load.mjs"`).

Arguments passed: `$ARGUMENTS`

This is the **Node/TypeScript** plugin. The only compiled script this skill
invokes is the deleter:

- Deleter (mechanical, the **only** thing that removes shared memory):
  `node "$CLAUDE_PLUGIN_ROOT/scripts/unshare.mjs"`. It self-locates nothing — you
  pass it absolute paths. It prints one JSON object on stdout and uses exit codes
  (see §Unshare).

There is **no** standalone resolver script in this layout. Resolution is a small,
deterministic, read-only derivation you perform yourself in **Step 1** (plain
`git` + the config JSON). Do not re-implement deletion, pushing, or sanitization
here — those live in the compiled scripts and `/share-memory`.

## Step 0 — resolve the data dir and config path (always do this first)

`CLAUDE_PLUGIN_DATA` may be unset; it defaults to `~/.claude-team-mem`. Resolve
the real paths once and reuse them:

```bash
DATA_DIR="${CLAUDE_PLUGIN_DATA:-$HOME/.claude-team-mem}"; DATA_DIR="${DATA_DIR%/}"
CONFIG="$DATA_DIR/config.json"
echo "data dir : $DATA_DIR"
echo "config   : $CONFIG"
```

Confirm the toolchain once and warn (do not abort) if missing:

```bash
command -v git  >/dev/null 2>&1 || echo "WARN: git not on PATH — sync/unshare will fail"
command -v node >/dev/null 2>&1 || echo "WARN: node not on PATH — unshare will fail"
command -v jq   >/dev/null 2>&1 || echo "WARN: jq not on PATH — config edits fall back to manual JSON"
```

## Step 1 — resolve the current project (read-only; needed by status / sync / unshare)

Do **not** hand-derive paths. Run the plugin's OWN resolver from the **project
directory** — it is the single source of truth (DESIGN §3, §11.2): it parses the
origin owner, applies the storage-spec precedence (`CLAUDE_TEAM_MEMORY_REPO` →
`config.owners` → disabled), the anti-circular guard, and the checkout / native
path derivation, AND performs the one-time **full** clone of the storage repo if
it is absent (so you never `git clone` yourself — a shallow clone would break a
later `pull --rebase`). `enable` and `list` touch only `$CONFIG` and may **skip**
this step.

```bash
RESOLVE=$(node "$CLAUDE_PLUGIN_ROOT/scripts/resolve.mjs" 2>/dev/null)
ENABLED=$(printf '%s' "$RESOLVE"      | jq -r '.enabled')
REASON=$(printf '%s' "$RESOLVE"       | jq -r '.reason // ""')
STORAGE_URL=$(printf '%s' "$RESOLVE"  | jq -r '.storageUrl // ""')
PROJECT_KEY=$(printf '%s' "$RESOLVE"  | jq -r '.projectKey // ""')
CHECKOUT_DIR=$(printf '%s' "$RESOLVE" | jq -r '.checkoutDir // ""')
TARGET_DIR=$(printf '%s' "$RESOLVE"   | jq -r '.targetMemoryDir // ""')
NATIVE_DIR=$(printf '%s' "$RESOLVE"   | jq -r '.nativeMemoryDir // ""')
```

If `ENABLED` is not `true`, team memory is **disabled** for this project and
`$REASON` says why (not a git repo / no origin, owner not in config, anti-circular
guard, or the clone failed). Report `$REASON` and stop — `status` says "disabled,"
and `sync` / `unshare` cannot proceed.

After Step 1 (enabled) you hold `STORAGE_URL`, `PROJECT_KEY`, `CHECKOUT_DIR`,
`TARGET_DIR`, `NATIVE_DIR` — the SAME values the SessionStart load and
`publish.mjs` / `unshare.mjs` use, because they all come from this one resolver.
Reuse them below. (No `jq`? Parse the one JSON object with `node -pe` instead.)

## Dispatch on the first argument

Parse `$ARGUMENTS`. The first token is the subcommand; the rest are operands.
Match case-insensitively. If empty, default to **status**. If unrecognized, print
the usage summary at the bottom and stop.

- `enable <owner> [repo|auto]` → **§Enable**
- `list` → **§List**
- `status` (or no args) → **§Status**
- `sync` → **§Sync**
- `unshare <slug>` → **§Unshare**

---

## §Enable — `enable <owner> [repo|auto]`

Map a GitHub **owner** (exactly the owner segment of a repo's `origin`) to a
storage repo in `config.json`. This is the opt-in switch from DESIGN §3 / §13:
only listed owners ever share memory. (Config-only — you may skip Step 1.)

The optional second operand selects the stored value:

| 2nd operand        | Stored config value  | Resolves to (DESIGN §3)                          |
|--------------------|----------------------|--------------------------------------------------|
| omitted, or `auto` | `"auto"`             | `<owner>/team-memory` on the project host |
| `someorg/somerepo` | `"someorg/somerepo"` | that explicit owner/repo on the project host     |
| a full git URL     | the URL verbatim     | that exact repo (any host)                       |

A "full git URL" is anything containing `://`, matching `user@host:owner/repo`,
or a local path (`/…`, `./…`, `../…`, `~/…`, `file://…`).

### Procedure

1. **Validate operands.** Require `<owner>`. If absent, print usage for `enable`
   and stop. Let `VALUE` be the second operand, defaulting to `auto`.
2. **Confirm intent.** Show exactly what will be written, e.g. *"Will set
   `owners["acme"] = "auto"` in `$CONFIG` (acme repos will share to
   acme/team-memory)."* Proceed without a second prompt for a plain
   `auto`; for an explicit repo/URL, echo it back so a typo is visible.
3. **Write the mapping** (atomic; seed `{}` and create parents as needed). Prefer
   `jq`; pass owner/value as `--arg` so odd characters can't break the JSON:
   ```bash
   mkdir -p "$DATA_DIR"
   [ -f "$CONFIG" ] || printf '{}\n' > "$CONFIG"
   tmp="$CONFIG.tmp.$$"
   jq --arg o "<owner>" --arg v "<VALUE>" '.owners[$o] = $v' "$CONFIG" > "$tmp" \
     && mv "$tmp" "$CONFIG" || { rm -f "$tmp"; echo "FAILED to update $CONFIG"; }
   ```
   If `jq` is unavailable, read `$CONFIG`, set `owners[<owner>] = <VALUE>` with the
   `Edit`/`Write` tool (preserve other keys + trailing newline), and write it back.
4. **Read back and confirm.** `jq '.owners' "$CONFIG"` (or re-read) and show it.
5. **Tell the user the next step:** the mapping takes effect on the **next**
   session start in a matching repo (the SessionStart hook clones + loads), or
   immediately via `/team-memory sync` from a repo owned by `<owner>`. If they
   haven't created the storage repo yet, point them at DESIGN §13 (create a
   private `<owner>/team-memory`; `auto` clones it on next load).

> To remove an owner mapping, edit `config.json` directly
> (`jq 'del(.owners["<owner>"])'`) — disabling an owner is just config; it never
> touches already-published memory (that is `unshare`).

---

## §List — `list`

Show every configured owner and **how each resolves** (config-only; no network,
skip Step 1).

1. If `$CONFIG` is missing or has no `.owners`, say so plainly ("No owners
   configured — team memory is disabled for every repo. Run `/team-memory enable
   <owner>`.") and stop.
2. Enumerate owners and raw values:
   ```bash
   jq -r '.owners // {} | to_entries[] | "\(.key)\t\(.value)"' "$CONFIG"
   ```
3. For each `owner → value`, explain the resolution in one line (no network):
   - `auto` → "→ `<owner>/team-memory` (auto, on the repo's own host)";
   - `owner/repo` → "→ `owner/repo` on the repo's host";
   - full git URL / local path → "→ that repo verbatim: `<value>`".
4. Note other relevant config keys if present (e.g. `maxIndexBytes`).
5. If `CLAUDE_TEAM_MEMORY_REPO` is actually set in the environment, mention that
   it **overrides** config per project (DESIGN §3 step 1).

Present as a short table/bullet list. Never clone or hit the network here.

---

## §Status — `status` (default)

Report team-memory state for the **current** project. Read-only.

1. **Resolve** (Step 1). If **disabled**, print `Team memory: DISABLED for this
   project` and the reason verbatim (e.g. "owner 'x' not configured", "not a git
   repo or no origin", "circular: storage repo == project origin"). If the reason
   is an unconfigured owner, offer the exact fix: `/team-memory enable <owner>`
   (derive `<owner>` from the origin). Stop.
2. **If enabled**, report:
   - **Storage repo** — `STORAGE_URL`
   - **Project key** — `PROJECT_KEY` (the `<org>/<repo>` subtree)
   - **Checkout path** — `CHECKOUT_DIR`
   - **Team memory dir** — `TARGET_DIR`
   - **Native memory dir** — `NATIVE_DIR`
3. **Checkout** — Step 1's resolver already cloned it (a FULL clone) if it was
   absent, so when `ENABLED` is true `$CHECKOUT_DIR/.git` exists. Do **not** clone
   here (a manual `--depth 1` clone would leave a shallow checkout that breaks a
   later `pull --rebase`). If the clone had failed, Step 1 already reported
   disabled with the reason (point at DESIGN §13 if the storage repo doesn't exist
   yet). `status` never pulls — that's `sync`.
4. **Count team files** in the subtree (top-level `*.md` only; `.tombstones/` is
   metadata, not memory):
   ```bash
   ls -1 "$TARGET_DIR"/*.md 2>/dev/null | wc -l | tr -d ' '
   ```
   List a few titles if helpful (read each file's `name:` frontmatter, fall back
   to filename).
5. **Detect conflicts** (DESIGN §6, §9). For each team file
   `$TARGET_DIR/<slug>.md`, inspect the **native** entry of the same name:
   ```bash
   for f in "$TARGET_DIR"/*.md; do
     [ -e "$f" ] || continue
     b=$(basename "$f"); n="$NATIVE_DIR/$b"
     if [ -e "$n" ] && [ ! -L "$n" ]; then
       echo "CONFLICT (real-vs-team): $b — a local real file shadows the team copy"
     elif [ -L "$n" ]; then
       tgt=$(cd "$(dirname "$n")" && readlink "$n" 2>/dev/null)
       case "$tgt" in
         "$CHECKOUT_DIR"/*) : ;;  # ours — fine
         *) echo "CONFLICT (unrelated-symlink): $b — a native symlink points OUTSIDE this checkout" ;;
       esac
     fi
   done
   ```
   Also flag, as a soft warning, any **dangling** native symlink that resolves
   **into** the checkout but whose target no longer exists (a since-unshared
   file); note it is pruned automatically on next load.
   - If `$NATIVE_DIR` doesn't exist, say symlink reconciliation isn't active for
     this project (index injection still works — DESIGN §6.5) and skip the
     per-file checks.
6. **Pending local commits in the checkout** (e.g. a prior push failed): if
   `git -C "$CHECKOUT_DIR" status --porcelain` is non-empty, or
   `git -C "$CHECKOUT_DIR" log --oneline @{u}.. 2>/dev/null` shows unpushed
   commits, surface that and suggest `/team-memory sync` (or just
   `git -C "$CHECKOUT_DIR" push`).

Summarize as a compact status block. Never write anything in `status`.

---

## §Sync — `sync`

Manually refresh the current project's checkout (`git pull --ff-only`). The load
hook normally refreshes in the background; this is the on-demand version.

1. **Resolve** (Step 1). If disabled, print the reason and stop — nothing to sync.
2. Let `CK = $CHECKOUT_DIR`. Step 1's resolver already created it (a FULL clone)
   if it was absent — do **not** clone here. If `"$CK/.git"` is somehow still
   missing, report and stop (re-run after a session start, which also clones).
3. **Warn on local divergence first.** If `git -C "$CK" status --porcelain` is
   non-empty (a symlinked memory was edited through the checkout, or a push failed
   mid-flight), tell the user **before** pulling and let them decide. Do **not**
   stash or discard their changes.
4. **Fast-forward only** (never clobber, never merge-commit, never force):
   ```bash
   git -C "$CK" pull --ff-only --quiet && echo "synced" || echo "could not fast-forward"
   ```
5. If `--ff-only` fails because local commits diverged, explain that local commits
   exist that aren't upstream (likely an unpushed publish/unshare) and suggest
   re-running `/share-memory` or `/team-memory unshare …`, which both
   `pull --rebase` then push. Do not auto-rebase here.
6. Report the post-sync team-file count (same as Status step 4) so the user sees
   what changed.

---

## §Unshare — `unshare <slug>` (THE ONLY DELETER)

Remove a **shared** memory from the storage repo, leaving a tombstone. This is the
single sanctioned deletion path (DESIGN §7.4: *publish never deletes*; §8.6:
*shared storage is only removed via an explicit, ownership-checked unshare*).
**You** own the ownership / sanity / confirmation gate; `unshare.mjs` does the
mechanical tombstone + `git rm` + commit + push (via the same `pull --rebase →
push` helper publish uses; it never force-pushes).

### Procedure

1. **Require a slug.** `<slug>` is the memory's file name (with or without `.md`).
   If absent, print usage for `unshare` and stop.
2. **Resolve** (Step 1). If disabled, print the reason and stop (you cannot
   unshare from a repo that isn't sharing). Capture `CHECKOUT_DIR`, `TARGET_DIR`,
   `NATIVE_DIR`, `PROJECT_KEY`.
3. **Sanity-check the file exists** in `$TARGET_DIR` (normalize `.md`):
   ```bash
   SLUGFILE="<slug>"; case "$SLUGFILE" in *.md) ;; *) SLUGFILE="$SLUGFILE.md" ;; esac
   ls -l "$TARGET_DIR/$SLUGFILE" 2>/dev/null || echo "NOT FOUND"
   ```
   If absent, tell the user it's already gone (a teammate may have unshared it —
   check `$TARGET_DIR/.tombstones/$SLUGFILE`) and stop.
4. **Refresh first** so the ownership check and delete are against current
   upstream state (best-effort; `unshare.mjs` does its own `pull --rebase` before
   pushing):
   ```bash
   git -C "$CHECKOUT_DIR" pull --ff-only --quiet || echo "WARN: could not fast-forward (proceeding)"
   ```
5. **Ownership / sanity check.** Show who last authored the file and its title,
   and make clear this affects **everyone** on the team:
   ```bash
   git -C "$CHECKOUT_DIR" log -1 --format='%an <%ae>  %ad' --date=short -- "$TARGET_DIR/$SLUGFILE"
   ```
   Read the file's `name`/`description` frontmatter and show a short body preview.
   Then **confirm explicitly**:
   - If the last author is **not** the current git user
     (`git -C "$CHECKOUT_DIR" config user.name` / `user.email`), say so plainly:
     *"This was last authored by <author>, not you. Unsharing removes it for the
     whole team."* Require a clear "yes, unshare it" before proceeding.
   - Ask for / confirm a one-line **reason** to record in the tombstone.
   Never proceed on ambiguity.
6. **Run the deleter.** Pass absolute paths; `--slug` may be with or without
   `.md`. Capture stdout (one JSON object) and the exit code:
   ```bash
   node "$CLAUDE_PLUGIN_ROOT/scripts/unshare.mjs" \
     --checkout-dir "$CHECKOUT_DIR" \
     --target-dir   "$TARGET_DIR" \
     --slug         "<slug>" \
     --reason       "<one-line reason>" \
     --by           "$(git -C "$CHECKOUT_DIR" config user.name)"
   echo "exit=$?"
   ```
   The JSON has `{ removed, pushed, conflict, tombstone, reason, notFound }`.
   Interpret the **exit code** (and corroborate with the JSON):
   - **0** — removed **and pushed**. Done.
   - **3** — file wasn't there (`notFound: true`); report "already gone" and stop.
   - **4** — committed locally but a **rebase conflict** blocked the push
     (`conflict: true`); a teammate changed the repo concurrently. Re-run step 4
     (refresh) and retry **once**; if it persists, inspect
     `git -C "$CHECKOUT_DIR" status` and resolve before retrying. Do **not** re-run
     `unshare.mjs` blindly (that would stack a second tombstone commit).
   - **5** — committed locally but the **push kept failing** (network/permissions).
     The removal + tombstone are committed in the checkout; tell the user to retry
     the push when connectivity/access is back — **just push the existing commit**:
     `git -C "$CHECKOUT_DIR" push`. Do **not** re-run `unshare.mjs`.
   - **2** — input/structural error (bad args, not a checkout, unsafe slug, or
     `git rm` couldn't be staged). Show the JSON `reason`/stderr and fix the inputs;
     nothing was committed.
7. **Reconcile the local native dir** (so the removed file stops appearing now):
   - If `$NATIVE_DIR/$SLUGFILE` is a **symlink into the checkout**, it's now
     dangling — remove it (the next SessionStart load would prune it anyway; doing
     it now keeps the session clean):
     ```bash
     [ -L "$NATIVE_DIR/$SLUGFILE" ] && rm "$NATIVE_DIR/$SLUGFILE"
     ```
   - If it's a **real file**, leave it (it was the user's own local copy, not team
     memory) and note it remains locally.
8. **Confirm** to the user: file removed from `$PROJECT_KEY` storage, tombstone
   recorded at `$TARGET_DIR/.tombstones/$SLUGFILE`, pushed. Remind them the fact
   should not be re-published without team agreement — the tombstone documents the
   removal, and `/share-memory` will **refuse** any slug that has a tombstone.

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
