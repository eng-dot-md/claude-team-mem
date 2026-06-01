#!/bin/bash
# unshare.sh — THE ONLY DELETER of shared team memory (DESIGN §7.4, §8.6).
#
# Publish NEVER deletes. Removing a shared fact from the storage repo is an
# explicit, ownership-checked action driven by the /team-memory skill. This
# script does the *mechanical* part only:
#   1. sanity-check that <slug>.md exists in the project's memory subtree;
#   2. write a TOMBSTONE record (so the deletion is auditable and a teammate's
#      stale local symlink resolves to an explanation rather than silently
#      vanishing);
#   3. `git rm` the shared file;
#   4. commit, then `git pull --rebase` + push with bounded retry on a race
#      (mirrors publish.sh; NEVER force-push, NEVER drop others' content).
#
# The CALLER (the /team-memory skill) is responsible for the ownership /
# confirmation gate BEFORE invoking this. This script refuses obviously-unsafe
# input (missing file, path traversal, dir not a checkout) but does not itself
# prompt the user.
#
# Usage:
#   unshare.sh --checkout <checkout-dir> --target <target-memory-dir> \
#              --slug <slug> [--reason <text>] [--by <author>] [--no-push]
#
# Notes:
#   - <target-memory-dir> is <checkout-dir>/<org>/<repo>/memory (from
#     resolve-repo.sh .targetMemoryDir). <slug> may be given with or without a
#     trailing ".md".
#   - Tombstones live in <target>/.tombstones/<slug>.md inside the SAME subtree,
#     so they travel with the project and never collide across projects.
#   - macOS /bin/bash 3.2 compatible; fail-soft; all paths quoted.
#
# Exit codes: 0 = removed (and pushed unless --no-push); non-zero = nothing was
# pushed (see stderr). On any failure the working tree is left clean enough for
# a later retry (a local commit may remain unpushed — reported as such).

# --- locate and source lib.sh (self-locating via CLAUDE_PLUGIN_ROOT) ---------
ctm__self="${BASH_SOURCE[0]:-$0}"
ctm__self_dir=$(CDPATH= cd -- "$(dirname -- "$ctm__self")" 2>/dev/null && pwd)
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "${CLAUDE_PLUGIN_ROOT}/scripts/lib.sh" ]; then
  . "${CLAUDE_PLUGIN_ROOT}/scripts/lib.sh"
elif [ -n "$ctm__self_dir" ] && [ -f "$ctm__self_dir/lib.sh" ]; then
  . "$ctm__self_dir/lib.sh"
else
  printf '[claude-team-mem] unshare: cannot locate lib.sh\n' >&2
  exit 1
fi

# --- parse args --------------------------------------------------------------
ctm_unshare__checkout=""
ctm_unshare__target=""
ctm_unshare__slug=""
ctm_unshare__reason=""
ctm_unshare__by=""
ctm_unshare__push=1

while [ $# -gt 0 ]; do
  case "$1" in
    --checkout) ctm_unshare__checkout="$2"; shift 2 ;;
    --target)   ctm_unshare__target="$2";   shift 2 ;;
    --slug)     ctm_unshare__slug="$2";     shift 2 ;;
    --reason)   ctm_unshare__reason="$2";   shift 2 ;;
    --by)       ctm_unshare__by="$2";       shift 2 ;;
    --no-push)  ctm_unshare__push=0;        shift ;;
    --) shift; break ;;
    *)
      ctm_log "unshare: unknown argument '$1'"
      exit 2
      ;;
  esac
done

if [ -z "$ctm_unshare__checkout" ] || [ -z "$ctm_unshare__target" ] || [ -z "$ctm_unshare__slug" ]; then
  ctm_log "unshare: --checkout, --target and --slug are all required"
  exit 2
fi

# --- normalize + validate the slug (no path traversal) -----------------------
# Accept "foo" or "foo.md"; reject anything with a slash or "..".
case "$ctm_unshare__slug" in
  *.md) ctm_unshare__base="${ctm_unshare__slug%.md}" ;;
  *)    ctm_unshare__base="$ctm_unshare__slug" ;;
esac
case "$ctm_unshare__base" in
  ""|*/*|*..*|.*)
    ctm_log "unshare: refusing unsafe slug '$ctm_unshare__slug' (must be a bare file name)"
    exit 2
    ;;
esac
ctm_unshare__file="${ctm_unshare__target%/}/$ctm_unshare__base.md"

# --- structural safety: target must be a memory subtree of a real checkout ---
if [ ! -d "$ctm_unshare__checkout/.git" ]; then
  ctm_log "unshare: '$ctm_unshare__checkout' is not a git checkout"
  exit 1
fi
if ! ctm_path_inside "$ctm_unshare__target" "$ctm_unshare__checkout"; then
  ctm_log "unshare: target dir is not inside the checkout (refusing)"
  exit 1
fi
if [ ! -f "$ctm_unshare__file" ]; then
  ctm_log "unshare: no shared file '$ctm_unshare__base.md' in $ctm_unshare__target (nothing to remove)"
  # Not an error the caller should retry; treat as a soft no-op failure so the
  # skill can report "already gone".
  exit 3
fi

# --- gather provenance for the tombstone -------------------------------------
ctm_unshare__last_author=$(git -C "$ctm_unshare__checkout" log -1 --format='%an <%ae>' -- "$ctm_unshare__file" 2>/dev/null)
[ -z "$ctm_unshare__last_author" ] && ctm_unshare__last_author="unknown"
ctm_unshare__when=$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)
[ -z "$ctm_unshare__by" ] && ctm_unshare__by=$(git -C "$ctm_unshare__checkout" config user.name 2>/dev/null)
[ -z "$ctm_unshare__by" ] && ctm_unshare__by="unknown"
[ -z "$ctm_unshare__reason" ] && ctm_unshare__reason="(no reason given)"

# Title of the removed memory (for a human-readable tombstone), best-effort.
ctm_unshare__title=$(awk '
  /^---[[:space:]]*$/ { c++; next }
  c==1 && /^name:/ { sub(/^name:[[:space:]]*/, ""); print; exit }
' "$ctm_unshare__file" 2>/dev/null)
[ -z "$ctm_unshare__title" ] && ctm_unshare__title="$ctm_unshare__base"

# --- write the tombstone -----------------------------------------------------
ctm_unshare__tdir="${ctm_unshare__target%/}/.tombstones"
ctm_unshare__tfile="$ctm_unshare__tdir/$ctm_unshare__base.md"
mkdir -p "$ctm_unshare__tdir" 2>/dev/null || {
  ctm_log "unshare: could not create tombstone dir $ctm_unshare__tdir"
  exit 1
}

{
  printf -- '---\n'
  printf 'tombstone: true\n'
  printf 'slug: %s\n' "$ctm_unshare__base"
  printf 'title: %s\n' "$ctm_unshare__title"
  printf 'removedAt: %s\n' "$ctm_unshare__when"
  printf 'removedBy: %s\n' "$ctm_unshare__by"
  printf 'lastAuthor: %s\n' "$ctm_unshare__last_author"
  printf -- '---\n'
  printf 'This shared memory was unshared via `/team-memory unshare %s`.\n\n' "$ctm_unshare__base"
  printf 'Reason: %s\n\n' "$ctm_unshare__reason"
  printf 'The fact is no longer team memory. Do not re-publish it without checking\n'
  printf 'with the team first. (Delete this tombstone if the fact is later\n'
  printf 'legitimately re-shared under the same slug.)\n'
} > "$ctm_unshare__tfile" 2>/dev/null || {
  ctm_log "unshare: could not write tombstone $ctm_unshare__tfile"
  exit 1
}

# --- remove the shared file --------------------------------------------------
# `git rm` both deletes the worktree file AND stages the deletion. If it fails
# on a TRACKED file (lock / permission / transient), we must NOT silently fall
# back to a plain `rm` and proceed: that would leave the deletion UNSTAGED, the
# file would survive in HEAD, get pushed back to the team, and unshare would
# still report success — a no-op "unshare" (DESIGN §7.4, §8.6). So: try git rm;
# if that fails, force the deletion AND stage it via `rm` + `git add -A` of the
# path; if the deletion still isn't staged, treat it as a hard error and bail
# (no commit) so the skill reports it rather than emitting a false success.
if ! git -C "$ctm_unshare__checkout" rm -q -f "$ctm_unshare__file" >/dev/null 2>&1; then
  rm -f "$ctm_unshare__file" 2>/dev/null
  # Record the worktree deletion in the index so the commit actually removes it.
  git -C "$ctm_unshare__checkout" add -A -- "$ctm_unshare__file" >/dev/null 2>&1
  # Verify the path is genuinely staged-for-deletion (no longer in the index).
  if git -C "$ctm_unshare__checkout" ls-files --error-unmatch -- "$ctm_unshare__file" >/dev/null 2>&1; then
    ctm_log "unshare: could not stage removal of $ctm_unshare__base.md; aborting (nothing committed)"
    exit 1
  fi
fi
git -C "$ctm_unshare__checkout" add -- "$ctm_unshare__tfile" >/dev/null 2>&1

# --- commit ------------------------------------------------------------------
ctm_unshare__msg="chore(memory): unshare $ctm_unshare__base

Remove shared memory '$ctm_unshare__title' and record a tombstone.
Reason: $ctm_unshare__reason
Removed-by: $ctm_unshare__by"

# Commit ONLY the removed file and the tombstone. A pathspec'd commit records
# the staged deletion of the slug and the new tombstone while ignoring any other
# index entry, so an out-of-band `git add` of an unrelated teammate file can
# never ride along into this unshare push (DESIGN §7.4, §8.6).
if ! git -C "$ctm_unshare__checkout" commit -q -m "$ctm_unshare__msg" -- "$ctm_unshare__file" "$ctm_unshare__tfile" >/dev/null 2>&1; then
  ctm_log "unshare: nothing committed (no staged changes?)"
  exit 1
fi
ctm_log "unshare: committed removal of $ctm_unshare__base + tombstone"

if [ "$ctm_unshare__push" -eq 0 ]; then
  ctm_log "unshare: --no-push set; local commit left for the caller to push"
  exit 0
fi

# --- pull --rebase + push with bounded retry (mirror publish.sh, §9) ---------
ctm_unshare__branch=$(git -C "$ctm_unshare__checkout" rev-parse --abbrev-ref HEAD 2>/dev/null)
[ -z "$ctm_unshare__branch" ] && ctm_unshare__branch="HEAD"

ctm_unshare__try=0
ctm_unshare__max=3
while [ "$ctm_unshare__try" -lt "$ctm_unshare__max" ]; do
  ctm_unshare__try=$((ctm_unshare__try + 1))

  # Rebase onto the remote. A conflict here would be unusual for a pure delete,
  # but if it happens we abort the rebase and bail so the caller (Claude) can
  # reconcile rather than this script guessing.
  if ! git -C "$ctm_unshare__checkout" pull --rebase --quiet >/dev/null 2>&1; then
    git -C "$ctm_unshare__checkout" rebase --abort >/dev/null 2>&1
    ctm_log "unshare: pull --rebase failed/conflicted (attempt $ctm_unshare__try); not pushed"
    exit 4
  fi

  if git -C "$ctm_unshare__checkout" push origin "$ctm_unshare__branch" >/dev/null 2>&1; then
    ctm_log "unshare: pushed removal of $ctm_unshare__base"
    exit 0
  fi

  ctm_log "unshare: push rejected (attempt $ctm_unshare__try); re-pulling and retrying"
done

ctm_log "unshare: push still failing after $ctm_unshare__max attempts; local commit kept (retry later)"
exit 5
