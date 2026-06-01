#!/bin/bash
# publish.sh — the git MECHANICS of publishing team memory.
#
# This script does NOT classify, sanitize, or merge — that reasoning lives in
# the /share-memory skill (Claude). By the time publish.sh runs, the skill has
# ALREADY written the final, sanitized, semantically-merged bytes for each
# slug into the checkout's target memory dir (<targetMemoryDir>/<slug>.md).
# publish.sh's job is purely:
#
#   1. git fetch (see the teammate pushes that landed first; NO worktree merge)
#   2. stage + commit the named slug files (tree becomes clean)
#   3. rebase our commit onto upstream (clean tree → a conflict cleanly STOPS,
#      is detected, aborted, and reported for Claude to resolve — DESIGN §9)
#   4. push, with a bounded retry on push races (re-fetch + rebase, then retry)
#   5. NEVER force-push; NEVER delete files from the checkout
#   6. after a SUCCESSFUL push, for each just-published slug: convert the local
#      native REAL file to a symlink into the checkout ONLY if its bytes are
#      byte-identical to the pushed copy. If they differ (sanitized / merged),
#      KEEP the local real file as-is (no data loss — DESIGN §7.8). If push
#      failed, keep ALL local real files and report.
#
# Ordering note: we commit BEFORE we rebase (not `pull --rebase --autostash`
# before committing) precisely because the skill's slug files arrive as
# UNCOMMITTED working-tree changes; an autostash-pop after a rebase can silently
# leave conflict markers in those files, which we would then commit. Committing
# first keeps the tree clean so a real conflict stops the rebase instead.
#
# Contract (DESIGN §7, §8, §9):
#   - Publish never deletes from the checkout (DESIGN §7.4). Local absence is
#     NOT authority to delete; deletion is only via /team-memory unshare.
#   - Never force-push, never drop teammates' content (DESIGN §9).
#   - Fail-soft: on any unrecoverable git failure, leave local real files intact
#     and emit a machine-readable result so the skill can report accurately.
#
# macOS /bin/bash 3.2 compatible: no `declare -A`, no `${x^^}`, no
# `mapfile`/`readarray`, no `&>>`, no pipe-into-`while`-that-mutates-state (each
# pipe side is a subshell in 3.2; we iterate via the positional parameters in
# the current shell instead). Uses jq for JSON escaping when present.
#
# ----------------------------------------------------------------------------
# Usage
# ----------------------------------------------------------------------------
#   publish.sh \
#       --checkout-dir   <checkoutDir> \
#       --target-dir     <targetMemoryDir> \
#       --native-dir     <nativeMemoryDir> \
#       [--message       <commit message>] \
#       [--retries       <n>]              (default 5) \
#       --slug <slug.md> [--slug <slug.md> ...]
#
#   Slugs are the basenames (e.g. "foo.md") the skill has already written into
#   <targetMemoryDir>. They are the EXACT set to publish; publish.sh stages only
#   these explicit paths (never `git add -A`), so stray/teammate files in the
#   working tree are never swept in, and nothing is ever removed.
#
# ----------------------------------------------------------------------------
# Output (stdout): exactly one JSON object, then exit 0 (ALWAYS — fail-soft).
# ----------------------------------------------------------------------------
#   {
#     "published": true|false,        // push succeeded OR was a clean no-op?
#     "pushed":    true|false,        // did we actually push a commit?
#     "committed": true|false,        // did we create a commit?
#     "reason":    "<human string>",
#     "commit":    "<sha or empty>",
#     "attempts":  <int>,             // push attempts made
#     "slugs": [                      // per-slug outcome
#       { "slug": "foo.md",
#         "inCheckout": true|false,   // file present in the checkout?
#         "linked":     true|false,   // converted native real file -> symlink?
#         "keptLocal":  true|false,   // kept the native real file as-is?
#         "note":       "<why>" }
#     ]
#   }
#
# Exit code is ALWAYS 0; read "published"/"pushed" from the JSON. (A skill/hook
# must never be killed by this script.)

# --- locate and source lib.sh (self-locating via CLAUDE_PLUGIN_ROOT) ---------
ctm__self="${BASH_SOURCE[0]:-$0}"
ctm__self_dir=$(CDPATH= cd -- "$(dirname -- "$ctm__self")" 2>/dev/null && pwd)
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "${CLAUDE_PLUGIN_ROOT}/scripts/lib.sh" ]; then
  . "${CLAUDE_PLUGIN_ROOT}/scripts/lib.sh"
elif [ -n "$ctm__self_dir" ] && [ -f "$ctm__self_dir/lib.sh" ]; then
  . "$ctm__self_dir/lib.sh"
else
  printf '{"published":false,"pushed":false,"committed":false,"reason":"cannot locate lib.sh","commit":"","attempts":0,"slugs":[]}\n'
  exit 0
fi

# ============================================================================
# Result state (module-level; mutated by helpers in the CURRENT shell only).
# ============================================================================
ctm_pub__slug_json=""        # comma-joined per-slug JSON objects
ctm_pub__commit_sha=""
ctm_pub__attempts=0
ctm_pub__committed="false"
ctm_pub__pushed="false"
ctm_pub__published="false"
ctm_pub__reason=""

# Inputs (filled by arg parsing).
ctm_pub__checkout=""
ctm_pub__target=""
ctm_pub__native=""
ctm_pub__message=""
ctm_pub__retries=5
ctm_pub__has_upstream="false"
ctm_pub__target_rel=""

# ============================================================================
# Small helpers
# ============================================================================

# ctm_pub_git <git args...> : run git in the checkout, quiet. Returns git's rc.
ctm_pub_git() {
  git -C "$ctm_pub__checkout" "$@" >/dev/null 2>&1
}

# ctm_pub_same_bytes <a> <b> : rc 0 if files are byte-identical, else 1. rc 1 if
# either is missing. No stdout.
ctm_pub_same_bytes() {
  [ -f "$1" ] || return 1
  [ -f "$2" ] || return 1
  cmp -s "$1" "$2"
}

# ctm_pub_json_str <string> : echo as a quoted+escaped JSON string value.
ctm_pub_json_str() {
  ctm_json_escape "$1"
}

# ctm_pub_add_slug_result <slug> <inCheckout> <linked> <keptLocal> <note>
# Appends one JSON object to ctm_pub__slug_json (CURRENT shell — no subshell).
ctm_pub_add_slug_result() {
  ctm_pub_add_slug_result__obj=$(printf '{"slug":%s,"inCheckout":%s,"linked":%s,"keptLocal":%s,"note":%s}' \
    "$(ctm_pub_json_str "$1")" "$2" "$3" "$4" "$(ctm_pub_json_str "$5")")
  if [ -n "$ctm_pub__slug_json" ]; then
    ctm_pub__slug_json="$ctm_pub__slug_json,$ctm_pub_add_slug_result__obj"
  else
    ctm_pub__slug_json="$ctm_pub_add_slug_result__obj"
  fi
}

# ctm_pub_emit : print the single result JSON object and exit 0.
ctm_pub_emit() {
  printf '{"published":%s,"pushed":%s,"committed":%s,"reason":%s,"commit":%s,"attempts":%s,"slugs":[%s]}\n' \
    "$ctm_pub__published" \
    "$ctm_pub__pushed" \
    "$ctm_pub__committed" \
    "$(ctm_pub_json_str "$ctm_pub__reason")" \
    "$(ctm_pub_json_str "$ctm_pub__commit_sha")" \
    "$ctm_pub__attempts" \
    "$ctm_pub__slug_json"
  exit 0
}

# ctm_pub_keep_all_local : record EVERY positional slug as kept-local (not
# linked). Used on any path where we did NOT push successfully. Iterates the
# positional parameters ("$@") in the current shell (no pipe/subshell).
ctm_pub_keep_all_local() {
  for ctm_pub_keep__slug in "$@"; do
    [ -z "$ctm_pub_keep__slug" ] && continue
    if [ -f "$ctm_pub__target/$ctm_pub_keep__slug" ]; then
      ctm_pub_keep__incheckout="true"
    else
      ctm_pub_keep__incheckout="false"
    fi
    ctm_pub_add_slug_result "$ctm_pub_keep__slug" "$ctm_pub_keep__incheckout" "false" "true" "not pushed; local real file kept"
  done
}

# ctm_pub_link_identical : for each positional slug, decide what to do with the
# NATIVE copy now that the checkout copy is the source of truth (post-push):
#   - checkout copy missing            -> inCheckout=false, keptLocal=true
#   - native already a symlink         -> already team; report linked=true
#   - no native file                   -> create the symlink
#   - native real file, bytes ==       -> replace with a symlink (atomic mv)
#   - native real file, bytes DIFFER   -> KEEP it (DESIGN §7.8)
# Never deletes the checkout copy. Iterates "$@" in the current shell.
ctm_pub_link_identical() {
  if [ -z "$ctm_pub__native" ]; then
    # No native dir resolved (load degraded / non-darwin). Record per-slug state
    # against the checkout; make no FS changes in the native dir.
    for ctm_pub_link__slug in "$@"; do
      [ -z "$ctm_pub_link__slug" ] && continue
      if [ -f "$ctm_pub__target/$ctm_pub_link__slug" ]; then
        ctm_pub_add_slug_result "$ctm_pub_link__slug" "true" "false" "false" "no native dir; checkout updated, nothing linked"
      else
        ctm_pub_add_slug_result "$ctm_pub_link__slug" "false" "false" "false" "no native dir; checkout copy missing"
      fi
    done
    return 0
  fi

  for ctm_pub_link__slug in "$@"; do
    [ -z "$ctm_pub_link__slug" ] && continue
    ctm_pub_link__src="$ctm_pub__target/$ctm_pub_link__slug"   # checkout copy
    ctm_pub_link__dst="$ctm_pub__native/$ctm_pub_link__slug"   # native copy

    if [ ! -f "$ctm_pub_link__src" ]; then
      ctm_pub_add_slug_result "$ctm_pub_link__slug" "false" "false" "true" "checkout copy missing; local kept"
      continue
    fi

    # Already a symlink => already a team file pointing into the checkout; leave
    # it (load.sh owns symlink reconciliation). Report as linked.
    if [ -L "$ctm_pub_link__dst" ]; then
      ctm_pub_add_slug_result "$ctm_pub_link__slug" "true" "true" "false" "native already a symlink (already team)"
      continue
    fi

    # No native file at all: create the symlink so native recall follows it.
    if [ ! -e "$ctm_pub_link__dst" ]; then
      mkdir -p "$ctm_pub__native" 2>/dev/null
      if ln -s "$ctm_pub_link__src" "$ctm_pub_link__dst" 2>/dev/null; then
        ctm_pub_add_slug_result "$ctm_pub_link__slug" "true" "true" "false" "created symlink (no prior native file)"
      else
        ctm_pub_add_slug_result "$ctm_pub_link__slug" "true" "false" "false" "could not create symlink; checkout has the copy"
      fi
      continue
    fi

    # Native is a REAL file. Convert to a symlink ONLY if byte-identical.
    if ctm_pub_same_bytes "$ctm_pub_link__dst" "$ctm_pub_link__src"; then
      # Atomic replace: create the link under a temp name, then mv it over the
      # real file (mv of a symlink onto a file in the same dir is atomic).
      ctm_pub_link__tmp="$ctm_pub_link__dst.ctmlink.$$"
      rm -f "$ctm_pub_link__tmp" 2>/dev/null
      if ln -s "$ctm_pub_link__src" "$ctm_pub_link__tmp" 2>/dev/null && mv -f "$ctm_pub_link__tmp" "$ctm_pub_link__dst" 2>/dev/null; then
        ctm_pub_add_slug_result "$ctm_pub_link__slug" "true" "true" "false" "identical to pushed copy; converted local real file to symlink"
      else
        rm -f "$ctm_pub_link__tmp" 2>/dev/null
        ctm_pub_add_slug_result "$ctm_pub_link__slug" "true" "false" "true" "identical but symlink conversion failed; local real file kept"
      fi
    else
      # Bytes differ (sanitized / merged). KEEP the local real file (DESIGN §7.8).
      ctm_pub_add_slug_result "$ctm_pub_link__slug" "true" "false" "true" "differs from pushed copy (sanitized/merged); local real file kept (offer to split into a personal memory)"
    fi
  done
  return 0
}

# ============================================================================
# Argument parsing.
#
# We collect slug basenames into the POSITIONAL parameters (via `set --`) so we
# can iterate them later in the current shell without a pipe/subshell. Non-slug
# inputs go into module variables. To do that we first gather slugs into a
# newline string, then rebuild "$@" from it at the end of parsing.
# ============================================================================
ctm_pub__slug_lines=""
while [ $# -gt 0 ]; do
  case "$1" in
    --checkout-dir) ctm_pub__checkout="$2"; shift 2 ;;
    --target-dir)   ctm_pub__target="$2";   shift 2 ;;
    --native-dir)   ctm_pub__native="$2";   shift 2 ;;
    --message)      ctm_pub__message="$2";  shift 2 ;;
    --retries)      ctm_pub__retries="$2";  shift 2 ;;
    --slug)
      if [ -n "$2" ]; then
        ctm_pub__slug_one="${2##*/}"   # basename guard
        if [ -n "$ctm_pub__slug_lines" ]; then
          ctm_pub__slug_lines="$ctm_pub__slug_lines
$ctm_pub__slug_one"
        else
          ctm_pub__slug_lines="$ctm_pub__slug_one"
        fi
      fi
      shift 2
      ;;
    *) shift 1 ;;   # unknown arg — ignore (fail-soft)
  esac
done

# Rebuild the positional parameters from the slug lines (newline-delimited).
# Slugs are filesystem basenames; setting IFS to newline keeps any odd spaces
# in a filename intact. Disable globbing so a '*' in a name is not expanded.
set -f
ctm_pub__OLDIFS="$IFS"
IFS='
'
# shellcheck disable=SC2086
set -- $ctm_pub__slug_lines
IFS="$ctm_pub__OLDIFS"
set +f
# "$@" now holds the slug basenames (possibly zero).

# ============================================================================
# Validate inputs (fail-soft: emit a result, never abort hard).
# ============================================================================
if [ -z "$ctm_pub__checkout" ] || [ ! -d "$ctm_pub__checkout/.git" ]; then
  ctm_pub__reason="checkout dir missing or not a git repo: $ctm_pub__checkout"
  ctm_pub_emit
fi
if [ -z "$ctm_pub__target" ]; then
  ctm_pub__reason="no --target-dir provided"
  ctm_pub_emit
fi
if [ "$#" -eq 0 ]; then
  # Nothing to publish is a SUCCESSFUL no-op (the skill found nothing new).
  ctm_pub__published="true"
  ctm_pub__reason="no slugs to publish (no-op)"
  ctm_pub_emit
fi

# Default commit message.
if [ -z "$ctm_pub__message" ]; then
  ctm_pub__message="team-memory: publish shared memory"
fi

# Ensure git has an identity for the commit (the checkout is a plugin-managed
# clone; set a LOCAL identity only if none is configured, so we never clobber
# the user's global config).
ctm_pub__have_name=$(git -C "$ctm_pub__checkout" config user.name 2>/dev/null)
ctm_pub__have_email=$(git -C "$ctm_pub__checkout" config user.email 2>/dev/null)
if [ -z "$ctm_pub__have_name" ]; then
  git -C "$ctm_pub__checkout" config user.name "claude-team-mem" >/dev/null 2>&1
fi
if [ -z "$ctm_pub__have_email" ]; then
  git -C "$ctm_pub__checkout" config user.email "claude-team-mem@localhost" >/dev/null 2>&1
fi

# Does the current branch have an upstream?
if git -C "$ctm_pub__checkout" rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
  ctm_pub__has_upstream="true"
fi

# ============================================================================
# Step 1: fetch (update the remote-tracking ref only — NO merge into the
# working tree). The skill's just-written slug files are uncommitted working-
# tree changes; a `pull --rebase --autostash` here would stash them, rebase,
# then POP the stash, which can silently leave CONFLICT MARKERS in the files —
# and we would then commit corrupted content. So we deliberately fetch now and
# defer the rebase to AFTER we commit (Step 3), when the tree is clean and a
# real conflict cleanly STOPS the rebase (detectable + abortable). Fail-soft
# (offline / no upstream): proceed; the push step determines the real outcome.
# ============================================================================
if [ "$ctm_pub__has_upstream" = "true" ]; then
  ctm_pub_git fetch || ctm_log "publish: fetch failed (continuing; offline?)"
fi

# ============================================================================
# Step 2: stage ONLY the named slug paths, then commit.
# We stage explicit paths (never `git add -A`) and never `git rm`, so publish
# can neither sweep in unrelated files nor delete anything (DESIGN §7.4).
# ============================================================================
# Target dir relative to the checkout for nicer commit paths; fall back to the
# absolute path if it is not under the checkout (git -C tolerates both).
ctm_pub__target_rel="$ctm_pub__target"
case "$ctm_pub__target" in
  "$ctm_pub__checkout"/*) ctm_pub__target_rel="${ctm_pub__target#$ctm_pub__checkout/}" ;;
esac

# Stage ONLY this run's slugs, and accumulate the relative pathspec of each one
# that exists into a shell-quoted string. EVERY later git op (the no-op check
# AND the commit) is scoped to exactly these paths. A pathspec-less `git commit`
# would otherwise capture any unrelated change that happened to be staged in the
# checkout (e.g. a symlinked memory edited in place per DESIGN §11.3/§11.5, or a
# prior aborted run) and push a teammate's file that was never in --slug. We
# keep `$@` (the original slugs) intact for the later helpers; the pathspecs are
# eval-quoted so embedded spaces survive (bash 3.2 safe; no arrays).
ctm_pub__pathspecs=""      # space-joined, each entry single-quoted for eval
for ctm_pub__slug in "$@"; do
  [ -z "$ctm_pub__slug" ] && continue
  if [ -f "$ctm_pub__target/$ctm_pub__slug" ]; then
    git -C "$ctm_pub__checkout" add -- "$ctm_pub__target_rel/$ctm_pub__slug" >/dev/null 2>&1
    ctm_pub__pathspecs="$ctm_pub__pathspecs $(ctm_shellquote "$ctm_pub__target_rel/$ctm_pub__slug")"
  fi
done

# Anything staged vs HEAD for OUR pathspecs specifically? Scoping the check to
# the same paths means an unrelated already-staged file can't force a spurious
# commit, and a byte-identical dedupe run correctly reports a clean no-op.
# (For a repo with no commits yet, --cached still lists our staged additions, so
# this correctly reports "something to commit".)
ctm_pub__any_staged="false"
if [ -n "$ctm_pub__pathspecs" ]; then
  if ! eval "git -C \"\$ctm_pub__checkout\" diff --cached --quiet -- $ctm_pub__pathspecs" 2>/dev/null; then
    ctm_pub__any_staged="true"
  fi
fi

if [ "$ctm_pub__any_staged" != "true" ]; then
  # Nothing changed vs HEAD => every slug was byte-identical already (dedupe,
  # DESIGN §8.1), OR no slug existed to stage. SUCCESSFUL no-op. Still symlink
  # local real files to the already-committed checkout copies (bytes match HEAD).
  ctm_pub__published="true"
  ctm_pub__committed="false"
  ctm_pub__pushed="false"
  ctm_pub__reason="all slugs byte-identical to the checkout (no commit needed)"
  ctm_pub__commit_sha=$(git -C "$ctm_pub__checkout" rev-parse HEAD 2>/dev/null)
  ctm_pub_link_identical "$@"
  ctm_pub_emit
fi

# Commit ONLY the staged slug pathspecs. A pathspec'd commit ignores any other
# index entry, so an out-of-band `git add` of a teammate file can never ride
# along into this push (DESIGN §7.4, §9: never drop/modify others' content).
if ! eval "git -C \"\$ctm_pub__checkout\" commit -m \"\$ctm_pub__message\" -- $ctm_pub__pathspecs" >/dev/null 2>&1; then
  ctm_pub__reason="git commit failed; local real files kept"
  ctm_pub_keep_all_local "$@"
  ctm_pub_emit
fi
ctm_pub__committed="true"
ctm_pub__commit_sha=$(git -C "$ctm_pub__checkout" rev-parse HEAD 2>/dev/null)

# ============================================================================
# Step 3: rebase our fresh commit onto the upstream (the teammate push we
# fetched in Step 1). The working tree is CLEAN now (everything is committed),
# so a content conflict cleanly STOPS the rebase — there is no autostash-pop
# footgun, and we never commit conflict markers. publish.sh does NOT resolve
# conflicts (that is Claude's job — DESIGN §9): on conflict we abort the rebase
# (leaving our local commit intact for a later re-run) and report. NEVER force.
# ============================================================================
if [ "$ctm_pub__has_upstream" = "true" ]; then
  if ! ctm_pub_git rebase '@{u}'; then
    if [ -d "$ctm_pub__checkout/.git/rebase-merge" ] || [ -d "$ctm_pub__checkout/.git/rebase-apply" ]; then
      ctm_pub_git rebase --abort
      ctm_pub__reason="a teammate change conflicts with this commit; rebase aborted. Claude must merge both sides (DESIGN §9) then re-run /share-memory. Local files kept; commit $ctm_pub__commit_sha is local-only."
      ctm_pub_keep_all_local "$@"
      ctm_pub_emit
    fi
    # Non-conflict rebase failure (e.g. no upstream ref yet): proceed to push.
    ctm_log "publish: rebase onto upstream failed without a conflict (continuing to push)"
  fi
  # Rebase may have rewritten our commit; refresh the recorded sha.
  ctm_pub__commit_sha=$(git -C "$ctm_pub__checkout" rev-parse HEAD 2>/dev/null)
fi

# ============================================================================
# Step 4: push with a bounded retry on push races. On a rejected push, re-fetch
# + rebase onto the new upstream (NEVER --force) and retry. A rebase conflict
# during the loop is Claude's job → abort + report. We NEVER force-push.
# ============================================================================
case "$ctm_pub__retries" in
  ''|*[!0-9]*) ctm_pub__retries=5 ;;          # validate positive integer
esac
[ "$ctm_pub__retries" -lt 1 ] && ctm_pub__retries=1

ctm_pub__push_ok="false"
ctm_pub__i=0
while [ "$ctm_pub__i" -lt "$ctm_pub__retries" ]; do
  ctm_pub__i=$((ctm_pub__i + 1))
  ctm_pub__attempts="$ctm_pub__i"

  if [ "$ctm_pub__has_upstream" = "true" ]; then
    if ctm_pub_git push; then
      ctm_pub__push_ok="true"
      break
    fi
  else
    # First push of a brand-new branch: -u sets upstream (NOT a force).
    ctm_pub__branch=$(git -C "$ctm_pub__checkout" rev-parse --abbrev-ref HEAD 2>/dev/null)
    if [ -n "$ctm_pub__branch" ] && ctm_pub_git push -u origin "$ctm_pub__branch"; then
      ctm_pub__push_ok="true"
      ctm_pub__has_upstream="true"
      break
    fi
  fi

  # Push failed — most likely a race (someone pushed first). Re-sync: fetch the
  # new upstream, then rebase our commit onto it (the tree is clean post-commit,
  # so a conflict cleanly stops the rebase). Then loop to retry. NEVER force.
  ctm_log "publish: push attempt $ctm_pub__i failed; re-fetch + rebase then retry"
  if [ "$ctm_pub__has_upstream" = "true" ]; then
    if ! ctm_pub_git fetch; then
      # Lost the network mid-loop: stop retrying (report below).
      ctm_log "publish: re-fetch failed (offline?); stopping retries"
      break
    fi
    if ! ctm_pub_git rebase '@{u}'; then
      if [ -d "$ctm_pub__checkout/.git/rebase-merge" ] || [ -d "$ctm_pub__checkout/.git/rebase-apply" ]; then
        # Conflict during the rebase: publish.sh cannot resolve it. Abort,
        # leave the local commit intact (the skill re-fetches, Claude
        # reconciles, re-runs), and report.
        ctm_pub_git rebase --abort
        ctm_pub__reason="push race produced a rebase conflict; aborted. Claude must merge both sides (DESIGN §9) then re-run /share-memory. Local files kept; commit $ctm_pub__commit_sha is local-only."
        ctm_pub_keep_all_local "$@"
        ctm_pub_emit
      fi
      # Non-conflict rebase failure: stop retrying.
      ctm_log "publish: re-rebase failed without a conflict; stopping retries"
      break
    fi
    # Rebase rewrote our commit; refresh the recorded sha for accurate reporting.
    ctm_pub__commit_sha=$(git -C "$ctm_pub__checkout" rev-parse HEAD 2>/dev/null)
  fi
  # else: no upstream and push -u failed for a non-race reason (no remote / no
  # network). The bounded loop caps the futile retries; we then report below.
done

if [ "$ctm_pub__push_ok" != "true" ]; then
  # Committed locally but could not push. Keep ALL local real files (no data
  # loss) and report; the local commit stays for a later retry.
  ctm_pub__pushed="false"
  ctm_pub__published="false"
  ctm_pub__reason="committed locally but push failed after $ctm_pub__attempts attempt(s); local real files kept; commit $ctm_pub__commit_sha is local-only (re-run /share-memory to retry; never force-push)"
  ctm_pub_keep_all_local "$@"
  ctm_pub_emit
fi

# A rebase during the retry loop may have rewritten the commit; refresh the sha.
ctm_pub__commit_sha=$(git -C "$ctm_pub__checkout" rev-parse HEAD 2>/dev/null)
ctm_pub__pushed="true"
ctm_pub__published="true"
ctm_pub__reason="pushed after $ctm_pub__attempts attempt(s); commit $ctm_pub__commit_sha"

# ============================================================================
# Step 6 (post-push): convert each native REAL file to a symlink into the
# checkout ONLY if byte-identical to the pushed copy; otherwise keep the local
# real file (DESIGN §7.8). The skill offers to split any kept remainder into a
# personal memory so nothing sensitive is lost or shared.
# ============================================================================
ctm_pub_link_identical "$@"

ctm_pub_emit
