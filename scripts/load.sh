#!/bin/bash
# load.sh — SessionStart hook for claude-team-mem.
#
# Pipeline (every step fail-soft; this script NEVER exits non-zero and NEVER
# blocks session start):
#   1. source lib.sh (self-locating via CLAUDE_PLUGIN_ROOT).
#   2. run resolve-repo.sh -> JSON. If disabled, emit empty context, exit 0.
#   3. kick off a BACKGROUND `git -C <checkout> pull --ff-only` so the next
#      session sees updates; THIS session uses the already-checked-out copy.
#   4. reconcile THIS project's symlinks: for each
#         <targetMemoryDir>/*.md
#      ensure a symlink <nativeMemoryDir>/<slug>.md -> the team file; prune only
#      DANGLING symlinks that point INTO the checkout; never touch real files;
#      if a native REAL file shadows a team file name, record it as a conflict.
#   5. derive a fresh index from each team file's frontmatter (name/description;
#      fall back to first `#` heading / filename) as `- [Title](slug.md) — hook`
#      lines, behind a short preamble, plus any conflicts to surface.
#   6. inject the index as SessionStart additionalContext via JSON on stdout
#      (hookSpecificOutput.hookEventName = "SessionStart"). Bodies are NOT
#      injected (symlinks + native recall carry them).
#   - graceful degrade: if the native dir cannot be located, skip symlinking but
#     STILL inject the index (DESIGN §6.5).
#
# macOS /bin/bash 3.2 compatible. jq for JSON; awk/sed for text. Quote paths.

# --- locate and source lib.sh (self-locating via CLAUDE_PLUGIN_ROOT) ---------
ctm__self="${BASH_SOURCE[0]:-$0}"
ctm__self_dir=$(CDPATH= cd -- "$(dirname -- "$ctm__self")" 2>/dev/null && pwd)
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "${CLAUDE_PLUGIN_ROOT}/scripts/lib.sh" ]; then
  . "${CLAUDE_PLUGIN_ROOT}/scripts/lib.sh"
  ctm_load__scripts_dir="${CLAUDE_PLUGIN_ROOT}/scripts"
elif [ -n "$ctm__self_dir" ] && [ -f "$ctm__self_dir/lib.sh" ]; then
  . "$ctm__self_dir/lib.sh"
  ctm_load__scripts_dir="$ctm__self_dir"
else
  # Cannot even load the library; emit a valid empty SessionStart object so the
  # hook contract is honored, and stop.
  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":""}}\n'
  exit 0
fi

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

# ctm_load_emit_context <text> : print the SessionStart hook JSON carrying
# <text> as additionalContext, then exit 0. jq when present, hand-built escape
# fallback otherwise. Always the LAST thing this script does.
ctm_load_emit_context() {
  ctm_load_emit_context__text="$1"
  if ctm_have_jq; then
    jq -n --arg ctx "$ctm_load_emit_context__text" \
      '{hookSpecificOutput:{hookEventName:"SessionStart", additionalContext:$ctx}}'
  else
    printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":%s}}\n' \
      "$(ctm_json_escape "$ctm_load_emit_context__text")"
  fi
  exit 0
}

# ---------------------------------------------------------------------------
# Frontmatter / heading extraction (awk; no bash assoc arrays)
# ---------------------------------------------------------------------------

# ctm_load_field <file> <name|description> : echo the value of a top-level YAML
# frontmatter key from the leading `---`...`---` block. Strips surrounding
# single/double quotes and trailing whitespace. Echoes empty if absent. Only the
# first frontmatter block is consulted; nested/indented keys are ignored.
ctm_load_field() {
  ctm_load_field__file="$1"
  ctm_load_field__key="$2"
  [ -f "$ctm_load_field__file" ] || return 0
  awk -v key="$ctm_load_field__key" '
    NR==1 {
      if ($0 ~ /^---[[:space:]]*$/) { infm=1; next }
      else { exit }      # no frontmatter at all
    }
    infm==1 && /^---[[:space:]]*$/ { exit }   # end of frontmatter
    infm==1 {
      # match  key: value  at column 0 (no leading space = top-level key)
      line=$0
      if (match(line, /^[A-Za-z0-9_]+[[:space:]]*:/)) {
        k=line
        sub(/[[:space:]]*:.*$/, "", k)        # k = key name
        if (k == key) {
          v=line
          sub(/^[A-Za-z0-9_]+[[:space:]]*:[[:space:]]*/, "", v)  # v = value
          # strip trailing whitespace
          sub(/[[:space:]]+$/, "", v)
          # strip matching surrounding quotes
          if (v ~ /^".*"$/) { v=substr(v, 2, length(v)-2) }
          else if (v ~ /^'\''.*'\''$/) { v=substr(v, 2, length(v)-2) }
          print v
          exit
        }
      }
    }
  ' "$ctm_load_field__file" 2>/dev/null
  return 0
}

# ctm_load_first_heading <file> : echo the text of the first markdown `# ` ATX
# heading found OUTSIDE the leading frontmatter block. Echoes empty if none.
ctm_load_first_heading() {
  ctm_load_first_heading__file="$1"
  [ -f "$ctm_load_first_heading__file" ] || return 0
  awk '
    NR==1 && $0 ~ /^---[[:space:]]*$/ { infm=1; next }
    infm==1 && /^---[[:space:]]*$/ { infm=0; next }
    infm==1 { next }
    /^#[[:space:]]+/ {
      h=$0
      sub(/^#+[[:space:]]+/, "", h)
      sub(/[[:space:]]+$/, "", h)
      print h
      exit
    }
  ' "$ctm_load_first_heading__file" 2>/dev/null
  return 0
}

# ctm_load_title <file> <slug> : choose a display title for the index.
# Preference: frontmatter `name` -> first `#` heading -> the slug (filename
# without .md). Collapses any newlines just in case.
ctm_load_title() {
  ctm_load_title__file="$1"
  ctm_load_title__slug="$2"
  ctm_load_title__t=$(ctm_load_field "$ctm_load_title__file" name)
  if [ -z "$ctm_load_title__t" ]; then
    ctm_load_title__t=$(ctm_load_first_heading "$ctm_load_title__file")
  fi
  if [ -z "$ctm_load_title__t" ]; then
    ctm_load_title__t="$ctm_load_title__slug"
  fi
  printf '%s' "$ctm_load_title__t" | tr '\n' ' '
  return 0
}

# ctm_load_one_line <string> : squeeze a value to a single trimmed line (drop
# any embedded newlines, collapse leading/trailing space) for index hooks.
ctm_load_one_line() {
  printf '%s' "$1" | tr '\n' ' ' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
  return 0
}

# ---------------------------------------------------------------------------
# Run resolution
# ---------------------------------------------------------------------------

ctm_load__resolver="$ctm_load__scripts_dir/resolve-repo.sh"
if [ ! -f "$ctm_load__resolver" ]; then
  ctm_load_emit_context ""
fi

# resolve-repo.sh always prints one JSON object on stdout and exits 0.
ctm_load__json=$(bash "$ctm_load__resolver" 2>/dev/null)

# Parse the resolution. ctm_json_get reads from a file, so feed via a temp file
# (fail-soft: any read failure -> empty -> treated as disabled).
ctm_load__enabled="false"
ctm_load__checkout=""
ctm_load__target=""
ctm_load__native=""
ctm_load__projectkey=""
if [ -n "$ctm_load__json" ] && ctm_have_jq; then
  ctm_load__enabled=$(printf '%s' "$ctm_load__json" | jq -r '.enabled // false' 2>/dev/null)
  ctm_load__checkout=$(printf '%s' "$ctm_load__json" | jq -r '.checkoutDir // ""' 2>/dev/null)
  ctm_load__target=$(printf '%s' "$ctm_load__json" | jq -r '.targetMemoryDir // ""' 2>/dev/null)
  ctm_load__native=$(printf '%s' "$ctm_load__json" | jq -r '.nativeMemoryDir // ""' 2>/dev/null)
  ctm_load__projectkey=$(printf '%s' "$ctm_load__json" | jq -r '.projectKey // ""' 2>/dev/null)
fi

# Disabled (or unparseable / jq missing) -> inject nothing, exit cleanly.
if [ "$ctm_load__enabled" != "true" ]; then
  ctm_load_emit_context ""
fi

# ---------------------------------------------------------------------------
# Step 3: background refresh (never blocks; this session uses the current copy)
# ---------------------------------------------------------------------------
if [ -n "$ctm_load__checkout" ] && [ -d "$ctm_load__checkout/.git" ]; then
  # Detached, output discarded, errors ignored. The next session sees the pull.
  # Even though this is backgrounded, force non-interactive git (matching the
  # synchronous clone in lib.sh) so a credential/host-key prompt can never leave
  # a stuck `git` child waiting on a terminal that nobody is reading.
  ( GIT_TERMINAL_PROMPT=0 \
    GIT_SSH_COMMAND="ssh -oBatchMode=yes -oConnectTimeout=5 -oStrictHostKeyChecking=accept-new" \
    git -C "$ctm_load__checkout" pull --ff-only >/dev/null 2>&1 </dev/null ) &
fi

# ---------------------------------------------------------------------------
# Step 4: reconcile this project's symlinks (only if native dir is locatable)
# ---------------------------------------------------------------------------
# Real-vs-team clashes (a native REAL file shadowing a team file name; DESIGN §9)
# accumulate here, one "slug" per line, to surface in the injected index.
ctm_load__conflicts=""
# Unrelated-symlink clashes (a native symlink with a team file's name that points
# OUTSIDE our checkout — a link the user made elsewhere) are tracked separately so
# they can be described accurately; they are NOT real-file clashes.
ctm_load__linkclashes=""
ctm_load__native_usable=0

if [ -n "$ctm_load__native" ]; then
  # Try to create the native dir if missing. If we cannot, degrade: skip
  # symlinking but still inject the index. We treat the native dir as usable
  # only if it exists (or we just made it) AND is a directory.
  if [ ! -d "$ctm_load__native" ]; then
    mkdir -p "$ctm_load__native" 2>/dev/null
  fi
  if [ -d "$ctm_load__native" ]; then
    ctm_load__native_usable=1
  fi
fi

# 4a. PRUNE dangling symlinks in the native dir that point INTO the checkout.
#     Only symlinks (-L) whose target no longer exists (! -e) and whose resolved
#     target path is inside the checkout are removed. Real files are never
#     touched; symlinks pointing elsewhere are never touched.
if [ "$ctm_load__native_usable" -eq 1 ] && [ -n "$ctm_load__checkout" ]; then
  for ctm_load__lnk in "$ctm_load__native"/*; do
    [ -e "$ctm_load__lnk" ] && continue          # exists & resolves -> keep
    [ -L "$ctm_load__lnk" ] || continue          # only consider symlinks
    # Dangling symlink. Read its (literal) target and prune only if it points
    # into our checkout, so we never disturb unrelated dangling links.
    ctm_load__tgt=$(readlink "$ctm_load__lnk" 2>/dev/null)
    case "$ctm_load__tgt" in
      "$ctm_load__checkout"/*|"$ctm_load__checkout")
        rm -f "$ctm_load__lnk" 2>/dev/null
        ctm_log "pruned dangling symlink $ctm_load__lnk"
        ;;
    esac
  done
fi

# 4b. LINK each team file into the native dir (idempotent).
if [ -n "$ctm_load__target" ] && [ -d "$ctm_load__target" ]; then
  for ctm_load__src in "$ctm_load__target"/*.md; do
    [ -f "$ctm_load__src" ] || continue          # no matches -> the literal glob; skip
    ctm_load__slug="${ctm_load__src##*/}"        # e.g. foo.md

    if [ "$ctm_load__native_usable" -eq 1 ]; then
      ctm_load__dest="$ctm_load__native/$ctm_load__slug"
      if [ -L "$ctm_load__dest" ]; then
        # Already a symlink: repoint only if it does not already resolve to src.
        ctm_load__cur=$(readlink "$ctm_load__dest" 2>/dev/null)
        if [ "$ctm_load__cur" != "$ctm_load__src" ]; then
          # Repoint only links that target our checkout (don't hijack a link the
          # user made elsewhere); otherwise flag it as an unrelated-symlink clash.
          case "$ctm_load__cur" in
            "$ctm_load__checkout"/*)
              ln -sf "$ctm_load__src" "$ctm_load__dest" 2>/dev/null
              ;;
            *)
              ctm_load__linkclashes="$ctm_load__linkclashes$ctm_load__slug
"
              ;;
          esac
        fi
      elif [ -e "$ctm_load__dest" ]; then
        # A REAL file (or dir) already occupies this name -> real-vs-team clash
        # (DESIGN §9). NEVER overwrite; record it as a conflict to surface.
        ctm_load__conflicts="$ctm_load__conflicts$ctm_load__slug
"
        ctm_log "conflict: native real file shadows team file $ctm_load__slug"
      else
        # Free slot -> create the symlink.
        ln -sf "$ctm_load__src" "$ctm_load__dest" 2>/dev/null
      fi
    fi
  done
fi

# ---------------------------------------------------------------------------
# Step 5: derive a fresh index from the team files
# ---------------------------------------------------------------------------
ctm_load__index_lines=""
ctm_load__count=0          # total team files for this project
ctm_load__shown=0          # entries actually included (after the byte cap)
ctm_load__index_bytes=0
ctm_load__truncated=0
# Index byte budget (DESIGN §3 maxIndexBytes; default 20000; a value of 0 or any
# non-integer means "no cap"). The cap applies to the index lines only, at line
# boundaries, and always keeps at least the first entry.
ctm_load__max_index=$(ctm_json_get "$(ctm_config_path)" '.maxIndexBytes' 20000)
case "$ctm_load__max_index" in
  ''|*[!0-9]*) ctm_load__max_index=20000 ;;   # not a non-negative integer -> default
esac
if [ -n "$ctm_load__target" ] && [ -d "$ctm_load__target" ]; then
  for ctm_load__src in "$ctm_load__target"/*.md; do
    [ -f "$ctm_load__src" ] || continue
    ctm_load__count=$((ctm_load__count + 1))
    if [ "$ctm_load__truncated" -eq 1 ]; then
      continue                                  # over budget: just keep counting
    fi
    ctm_load__slug="${ctm_load__src##*/}"
    ctm_load__title=$(ctm_load_one_line "$(ctm_load_title "$ctm_load__src" "${ctm_load__slug%.md}")")
    ctm_load__hook=$(ctm_load_one_line "$(ctm_load_field "$ctm_load__src" description)")
    if [ -n "$ctm_load__hook" ]; then
      ctm_load__line="- [$ctm_load__title]($ctm_load__slug) — $ctm_load__hook"
    else
      ctm_load__line="- [$ctm_load__title]($ctm_load__slug)"
    fi
    ctm_load__line_bytes=$(printf '%s\n' "$ctm_load__line" | wc -c | tr -d ' ')
    if [ "$ctm_load__max_index" -gt 0 ] && [ "$ctm_load__shown" -gt 0 ] \
       && [ $((ctm_load__index_bytes + ctm_load__line_bytes)) -gt "$ctm_load__max_index" ]; then
      ctm_load__truncated=1
      continue
    fi
    ctm_load__index_bytes=$((ctm_load__index_bytes + ctm_load__line_bytes))
    ctm_load__index_lines="$ctm_load__index_lines$ctm_load__line
"
    ctm_load__shown=$((ctm_load__shown + 1))
  done
fi
# If the cap dropped entries, tell Claude how many and how to see them all.
if [ "$ctm_load__truncated" -eq 1 ]; then
  ctm_load__omitted=$((ctm_load__count - ctm_load__shown))
  ctm_load__index_lines="$ctm_load__index_lines- …and $ctm_load__omitted more team file(s); index capped at ${ctm_load__max_index} bytes (raise maxIndexBytes in config to list all).
"
fi

# Nothing shared for this project (and no clashes of either kind) -> inject nothing.
if [ "$ctm_load__count" -eq 0 ] && [ -z "$ctm_load__conflicts" ] && [ -z "$ctm_load__linkclashes" ]; then
  ctm_load_emit_context ""
fi

# ---------------------------------------------------------------------------
# Assemble the injected context: preamble + index (+ conflicts + degrade note).
# ---------------------------------------------------------------------------
ctm_load__hdr="# Team-shared memory"
if [ -n "$ctm_load__projectkey" ]; then
  ctm_load__hdr="# Team-shared memory ($ctm_load__projectkey)"
fi

ctm_load__preamble="The entries below are TEAM-SHARED memory synced from a private team storage repo. The full bodies are already on disk in this project's memory directory (as symlinks) — native recall reads them, so do NOT re-save them locally and do NOT re-share them. Treat each as a starting point: verify before relying on it, since a teammate may have written it earlier or for a slightly different context. On any conflict with what you already know or with a local note, prefer the newer and more specific information and reconcile rather than duplicate."

ctm_load__context="$ctm_load__hdr

$ctm_load__preamble"

if [ "$ctm_load__count" -gt 0 ]; then
  # Strip the single trailing newline left by the accumulation loop.
  ctm_load__index_trimmed=$(printf '%s' "$ctm_load__index_lines")
  ctm_load__context="$ctm_load__context

$ctm_load__index_trimmed"
fi

# Surface real-vs-team name clashes so Claude can reconcile (DESIGN §6.3/§9).
if [ -n "$ctm_load__conflicts" ]; then
  ctm_load__conflict_list=$(printf '%s' "$ctm_load__conflicts" | sed -e '/^$/d' -e 's/^/- /')
  ctm_load__context="$ctm_load__context

Name clashes (a local real file shares a name with a team file; the local file was NOT overwritten — reconcile, preferring the newer & more specific, then re-share if appropriate):
$ctm_load__conflict_list"
fi

# Surface unrelated-symlink clashes separately, with accurate wording: these are
# links the user pointed OUTSIDE the team checkout, not real-file clashes.
if [ -n "$ctm_load__linkclashes" ]; then
  ctm_load__linkclash_list=$(printf '%s' "$ctm_load__linkclashes" | sed -e '/^$/d' -e 's/^/- /')
  ctm_load__context="$ctm_load__context

Name clashes (an existing symlink shares a name with a team file but points OUTSIDE the team checkout; it was left untouched, so this team file is NOT linked into native recall — reconcile if the two refer to the same fact):
$ctm_load__linkclash_list"
fi

# If we have shared files but could not place symlinks, tell Claude where the
# bodies live so discoverability is preserved (DESIGN §6.5).
if [ "$ctm_load__count" -gt 0 ] && [ "$ctm_load__native_usable" -ne 1 ]; then
  ctm_load__context="$ctm_load__context

Note: the native memory directory could not be located on this machine, so these files are not linked into native recall. Their bodies are readable from: $ctm_load__target/<file>"
fi

ctm_load_emit_context "$ctm_load__context"
