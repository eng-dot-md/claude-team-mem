---
name: share-memory
description: Publish a team-relevant subset of this project's Claude memory to the team's shared git storage repo. Use when the user asks to "share memory", "publish memory", "push my notes/memory to the team", "share what I learned with the team", "sync my memory up", "share this with my teammates", or after a session that produced reusable project knowledge worth sharing. Classifies personal vs team, sanitizes secrets, semantically merges with teammates' copies, shows a review summary, waits for confirmation, then publishes. Never deletes shared memory (that is /team-memory unshare).
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash(git *)
  - Bash(ls *)
  - Bash(cat *)
  - Bash(mkdir *)
  - Bash(node "$CLAUDE_PLUGIN_ROOT"/scripts/*)
---

# share-memory — publish team memory

You are the **reasoning** half of the team-memory publish path. The git
**mechanics** (stage exact paths, commit, `pull --rebase` → push with bounded
retry, never force-push, convert a published local file to a symlink only when
byte-identical) live in `scripts/publish.mjs` (a bundled Node script); you must
NOT re-implement them. Your job is to decide *what* to publish and *what the
published bytes should be* (classify → sanitize → merge), present it for
confirmation, then hand the final bytes to `publish.mjs`.

This skill is **manual** (v1). Treat it as a careful, auditable operation:
nothing is shared without an explicit user "yes".

## Cardinal rules (read first)

1. **Publish NEVER deletes.** `publish.mjs` only adds/updates files in the
   checkout; it never runs `git rm`, never force-pushes, never removes a
   teammate's file. A file missing locally is **not** a reason to delete it
   upstream (it may belong to a teammate, or local reconcile may have degraded).
   The ONLY way to remove shared memory is the separate **`/team-memory
   unshare <slug>`** action (ownership check + tombstone). If the user asks you
   to "remove"/"delete"/"unshare" something here, tell them to use
   `/team-memory unshare` — do not try to delete via this skill. (DESIGN §7.4, §8.6)
2. **Sanitization is mandatory** on the team path, even though the storage repo
   is private. Strip secrets, tokens, credentials, auth-bearing URLs, private
   hostnames/IPs, personal asides, and **anything the workspace `CLAUDE.md`
   forbids exposing** (read it — see step 4). (DESIGN §5)
3. **When unsure whether something is personal or team → keep it personal.**
   Sharing is opt-in. (DESIGN §5)
4. **Never clobber a teammate's content.** When a team file already exists
   upstream and has diverged, **semantically merge** (union of facts; newer
   supersedes stale; keep compatible nuances) — do not overwrite. (DESIGN §7.3, §9)
5. **Slug = filename, upsert.** The same fact reuses the same `<slug>.md`. Never
   invent `foo-2.md`. Byte-identical content is skipped (no churn). (DESIGN §8.1)
6. **Confirm before publishing.** Always show the review summary and wait for an
   explicit yes. (DESIGN §7.6)

## Inputs / environment

- `${CLAUDE_PLUGIN_ROOT}` — the plugin dir; the bundled script is at
  `${CLAUDE_PLUGIN_ROOT}/scripts/publish.mjs` and runs under `node`.
- The memory file format is YAML frontmatter (`name`, `description`,
  `metadata: { type, scope, origin, ... }`) + a Markdown body. The plugin uses
  `metadata.scope` (`team` | `personal`) and, for shared files,
  `metadata.origin: team`.

## Procedure

### 1. Resolve the storage repo and paths

Resolution (env / config → checkout / target / native paths, the anti-circular
guard, and the one-time FULL clone) is owned by the plugin's resolver. Run it
directly from THIS project's directory and parse its JSON — do **not** re-derive
paths by hand, and do **not** scrape another skill's prose:

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

(No `jq`? Parse the single JSON object with `node -pe`.) When `ENABLED` is `true`:

- `STORAGE_URL` — resolved git URL of the storage repo.
- `CHECKOUT_DIR` — local clone of the storage repo (the resolver already cloned it
  if absent; it does **not** pull — fine, `publish.mjs` rebases onto upstream
  before pushing).
- `PROJECT_KEY` — `<org>/<repo>` subtree key for THIS project.
- `TARGET_DIR` — `<checkoutDir>/<projectKey>/memory` (where shared bytes go).
- `NATIVE_DIR` — this project's native Claude memory dir (real files + symlinks).
  May not exist on disk if native memory was never used here.

If `ENABLED` is not `true`, STOP and tell the user, quoting `$REASON` (owner not
configured, not a git repo, no origin, circular/self-reference, or the clone
failed). If the reason is "not configured", suggest `/team-memory enable <owner>`.

These are the SAME paths the SessionStart load and `unshare.mjs` use — they all
come from this one resolver, so what you publish links back correctly.

### 2. Enumerate candidate files (native REAL files only)

List `nativeMemoryDir`. For each `*.md` entry:

- **Skip symlinks** — a symlink already points into the checkout, i.e. it is
  *already team*. Re-publishing it is a no-op and risks treating teammate work
  as new local work. (DESIGN §7.2, §8.3)
- Consider only **real files**. These are the personal / unpublished / kept-back
  memories — the only things that can become *new* shared facts.

Identify symlinks with `ls -la` (a leading `l` / `->` arrow) or `test -L`. Also
ignore any `MEMORY.md` index file (the index is derived at load time and is never
published — DESIGN §7.5).

If `nativeMemoryDir` does not exist or has no real `*.md` files, tell the user
there is nothing local to share and stop.

### 3. Classify each candidate: personal vs team (DESIGN §5)

For each real file, read its frontmatter + body and decide:

1. **Authoritative:** if `metadata.scope` is present, obey it
   (`team` → candidate to share; `personal` → keep, never share).
2. **Untagged (legacy):** classify by content:
   - `metadata.type` of `project` / `reference` / `feedback`, or clearly
     project-/repo-general knowledge (architecture, build/test commands,
     conventions, gotchas, API shapes) → **team candidate**.
   - `metadata.type: user`, personal preferences, machine-specific quirks, local
     paths, "I prefer…", scratch/TODO notes → **personal**.
3. **When unsure → personal.** Do not share borderline content.

Build two lists: **TEAM candidates** and **PERSONAL (kept local)**.

### 4. Sanitize every team candidate (MANDATORY)

Before anything is shared, read the workspace policy and scrub each team
candidate's content:

- **Read the workspace `CLAUDE.md`** (walk up from the project root; there may be
  one at the repo root and one higher in the workspace). Honor every "do NOT
  expose / private / never reference publicly" rule it states. If it names
  private repos/paths/services that must not leak, **redact any mention** from
  the shared copy.
- Strip: API keys, tokens, passwords, private keys, `.env` values, bearer
  tokens, auth-bearing or signed URLs, internal hostnames/IPs, employee personal
  data, and personal asides ("I think", "remind me", machine-specific paths).
- Keep the *useful, shareable* knowledge: the reusable fact, minus the secret.

Track, per file, **what you redacted** (you will report it, and later offer to
preserve the redacted remainder locally). If sanitizing would gut the file to
nothing useful, move it to the PERSONAL list instead.

### 5. For each (sanitized) team file, reconcile against the checkout copy

Compute the same-slug path in the checkout: `targetMemoryDir/<slug>.md` (the
slug is the native filename, unchanged — **upsert**, never `-2`).

- **No existing copy** → this is a new shared fact: this run will stage the
  sanitized content as the new file.
- **Existing copy, byte-identical to your sanitized content** → it is already
  shared and unchanged. You may still pass it to `publish.mjs`; it will be
  detected as byte-identical and **skipped** (dedupe, no churn — DESIGN §8.1).
- **Existing copy, diverged** → **semantically merge** into one coherent fact
  (DESIGN §7.3, §9):
  - Union the facts; **do not drop the teammate's additions**.
  - Where they conflict, the **newer / more specific** statement supersedes the
    stale one; keep compatible nuances from both.
  - Re-derive a single clean frontmatter (`name`, `description`); set
    `metadata.scope: team`. Optionally add an `updated: YYYY-MM-DD` trail in the
    body. Do **not** add `metadata.origin: team` here (see the provenance note).
  - The merged text is the new shared copy.

Read both sides fully before merging. Never blind-overwrite.

> **Provenance backstop.** `metadata.origin: team` marks a fact as *received from
> the team* (it arrived via the checkout, typically loaded as a symlink — DESIGN
> §8.3). `publish.mjs` **refuses to publish any staged file whose frontmatter has
> `metadata.origin: team`** and reports it, so a fact you merely received can
> never loop back out as "new local work". Therefore: when you author or merge a
> shared fact, set `metadata.scope: team` but **leave `metadata.origin` unset** —
> otherwise `publish.mjs` will skip the very file you mean to share.

### 6. Write the final bytes into the checkout (staging the content)

For each team file that is **new or merged** (and also any you want re-checked
for an identical skip), write your final sanitized/merged content to
`targetMemoryDir/<slug>.md`, creating `targetMemoryDir` if needed. Do **not**
commit or push yourself — `publish.mjs` does that. Do **not** delete anything
from the checkout.

Keep a list of the **slugs you wrote** (basenames, e.g. `foo.md`) — that exact
set is what you pass to `publish.mjs`.

> A tombstone at `targetMemoryDir/.tombstones/<slug>` means that slug was
> deliberately retracted via `/team-memory unshare`. `publish.mjs` will **refuse**
> to re-publish a tombstoned slug and report it. Do not try to resurrect a
> retracted fact without team agreement.

### 7. Show the REVIEW SUMMARY and WAIT for explicit confirmation (DESIGN §7.6)

Present a concise, scannable summary, e.g.:

```
Team memory → <projectKey> in <storageUrl>

WILL SHARE (new):
  - api-conventions.md   "Internal API error envelope + retry policy"
WILL SHARE (merged with teammate's copy):
  - build-notes.md       merged: kept their bazel tip, added the pnpm filter note
UNCHANGED (already shared, will be skipped):
  - chain-ids.md
KEPT PERSONAL (not shared):
  - my-editor-setup.md   (type: user / personal preference)
REDACTIONS applied before sharing:
  - api-conventions.md   removed a staging bearer token and an internal hostname

Nothing is deleted. Proceed to publish these N file(s)? (yes / no / edit)
```

- List, per bucket: new shares, merges (one line on *what* you merged), skipped
  identical, kept-personal (with the reason), and **every redaction**.
- **Do not publish until the user explicitly says yes.** If they say "edit" or
  name exclusions, adjust the staged files/slug list and re-show the summary.
- If the user says no, stop (the checkout has your staged bytes but nothing is
  committed/pushed; that is harmless and will be overwritten or ignored next
  time — do not attempt to delete it).

### 8. Publish (call publish.mjs — the mechanics)

On confirmation, invoke the bundled script with the resolved paths and the exact
slug set you wrote. One `--slug` per file:

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/publish.mjs" \
  --checkout-dir "<checkoutDir>" \
  --target-dir   "<targetMemoryDir>" \
  --native-dir   "<nativeMemoryDir>" \
  --message      "team-memory: share <short description> for <projectKey>" \
  --slug foo.md --slug bar.md
```

Pass each path as its own argument exactly as resolved (no shell globbing — the
script stages each slug as an exact path). `publish.mjs` will: validate each
slug (skipping invalid ones), skip tombstoned and team-origin slugs, stage only
the named slugs (skipping byte-identical ones), `ensureIdentity` + commit, then
`pull --rebase` → push with bounded retry (**never force**), and on success
convert each native real file to an **absolute symlink** into the checkout
**only if its bytes are byte-identical** to the pushed copy. It prints **one
JSON object** to stdout and exits 0 on a normal run (a malformed invocation
errors to stderr with a non-zero exit). Read these fields:

- `published` — `true` if a push succeeded **or** it was a clean no-op.
- `pushed` / `committed` — what actually happened.
- `reason` — human explanation (quote it to the user).
- `commit` — the resulting commit sha (empty if none).
- `slugs[]` — per file: `accepted` (false = skipped: invalid / tombstoned /
  team-origin, with the reason in `note`), `inCheckout`, `linked` (converted to /
  left as a symlink into the checkout), `keptLocal` (kept the native real file
  as-is), and a `note`.

### 9. Handle the publish.mjs result (DESIGN §7.7, §7.8, §9)

- **`published == true`, all accepted slugs `linked`:** clean success. The shared
  bytes matched your local files exactly, so each local file is now an absolute
  symlink into the checkout. Tell the user what was published and that local
  recall is preserved.

- **Some slugs `keptLocal == true` (and `linked == false`):** the *shared* copy
  differs from your *local* file because you **sanitized or merged** it. This is
  by design — `publish.mjs` kept your full local real file so nothing sensitive
  was discarded *and* nothing sensitive was shared. → **Go to step 10** (offer to
  split the remainder).

- **`pushed == false` because of a conflict** (the `reason` mentions a rebase
  conflict / "Claude must merge both sides"): a teammate pushed a conflicting
  change. `publish.mjs` aborted the rebase cleanly and kept your local files; the
  remote was **not** clobbered, and your commit is local-only in the checkout. To
  resolve (DESIGN §9): in the checkout, run `git -C "<checkoutDir>" fetch` then
  `git -C "<checkoutDir>" log --oneline -3 "@{u}"`, read the upstream version of
  each conflicting `<slug>.md`, **semantically merge both sides** into the file
  under `targetMemoryDir`, then **re-run step 8** with the same slugs. Repeat
  until it pushes. **Never** tell the user to force-push.

- **`published == false` for another reason** (e.g. offline, push rejected after
  retries, commit failed): report `reason`. The local real files are kept and a
  local-only commit may exist in the checkout for a later retry. Suggest checking
  connectivity / auth and re-running `/share-memory` (or `/team-memory sync` to
  push the pending commit). Do not force anything.

- **Some slugs `accepted == false`:** quote their `note` — e.g. an invalid slug
  was skipped, a slug was refused because a tombstone exists (retracted via
  `/team-memory unshare`), or a file was skipped as already team-origin. These
  are intentional safety skips, not failures.

### 10. Offer to preserve the redacted / local-only remainder (DESIGN §7.8)

Whenever a file was `keptLocal` (sanitized or merged so the local bytes differ
from the shared copy), the local real file still holds the **full** content —
including the parts you redacted. Offer the user a choice so nothing is silently
lost *or* over-shared:

- **Split** the redacted/local-only remainder into a separate **personal**
  memory: create a new real file in `nativeMemoryDir` (e.g.
  `<slug>-private.md`) containing only the sensitive/local bits, with
  `metadata.scope: personal` in its frontmatter, and (optionally) trim those bits
  out of the original now-shared-and-symlinked topic. This keeps secrets local
  and out of the team repo permanently.
- **Or leave it as-is** — the local real file already retains everything; only
  the sanitized subset was shared.

Make the recommendation but let the user decide. Never move secret content into
the checkout.

## Notes & edge cases

- **Editing a symlinked memory edits the checkout copy** (uncommitted). That is
  expected; the next `/share-memory` (or a teammate's) will publish it. (DESIGN §11.3)
- **If `nativeMemoryDir` doesn't exist**, there are no local real files to share —
  stop with a friendly message. (Publishing is sourced from local memory.) If it
  exists but the resolver could not derive it (degraded), `publish.mjs` still
  updates the checkout; it just won't create symlinks — note that to the user.
- **Multiple projects / orgs** can map to one storage repo; the `projectKey`
  subtree keeps them separate. You only ever touch this project's subtree.
- This skill **adds and updates** only. For removal, defer to `/team-memory
  unshare <slug>`.
