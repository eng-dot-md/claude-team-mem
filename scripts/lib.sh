#!/bin/bash
# lib.sh — shared library for claude-team-mem.
#
# Sourced (not executed) by resolve-repo.sh, load.sh, publish.sh.
# macOS /bin/bash 3.2 compatible: no `declare -A`, no `${x^^}`, no
# `mapfile`/`readarray`, no `&>>`. Uses jq for JSON. Fail-soft: helpers
# return non-zero / echo empty on failure instead of aborting; callers in
# hook paths must never propagate a non-zero exit.
#
# All functions echo their result to stdout (and document it below). Diagnostic
# output goes to stderr via ctm_log so it never pollutes a function's stdout
# value or the JSON a hook prints.

# ---------------------------------------------------------------------------
# Diagnostics
# ---------------------------------------------------------------------------

# ctm_log <message...> : write a diagnostic line to stderr. Honors
# CLAUDE_TEAM_MEMORY_DEBUG (any non-empty value enables; unset = quiet but the
# line is always sent to stderr, which Claude Code discards for hooks). Never
# writes to stdout. Always returns 0.
ctm_log() {
  printf '[claude-team-mem] %s\n' "$*" >&2
  return 0
}

# ctm_shellquote <str> : echo <str> wrapped in single quotes, safe to splice
# into a string later run through `eval`. Embedded single quotes become the
# POSIX '\'' sequence. Used to build pathspec lists that must survive embedded
# spaces without a bash-4 array. Always returns 0.
ctm_shellquote() {
  ctm_shellquote__s=$(printf '%s' "$1" | sed "s/'/'\\\\''/g")
  printf "'%s'" "$ctm_shellquote__s"
  return 0
}

# ---------------------------------------------------------------------------
# Data dir / config path resolution
# ---------------------------------------------------------------------------

# ctm_data_dir : echo the single data directory.
# Resolves CLAUDE_PLUGIN_DATA, defaulting to ~/.claude-team-mem when unset or
# empty. No trailing slash. Always returns 0.
ctm_data_dir() {
  if [ -n "${CLAUDE_PLUGIN_DATA:-}" ]; then
    printf '%s' "${CLAUDE_PLUGIN_DATA%/}"
  else
    printf '%s' "$HOME/.claude-team-mem"
  fi
}

# ctm_config_path : echo the canonical config file path
# (<data-dir>/config.json). Always returns 0.
ctm_config_path() {
  printf '%s/config.json' "$(ctm_data_dir)"
}

# ctm_repos_dir : echo the directory that holds all storage checkouts
# (<data-dir>/repos). Always returns 0.
ctm_repos_dir() {
  printf '%s/repos' "$(ctm_data_dir)"
}

# ---------------------------------------------------------------------------
# JSON helpers (jq)
# ---------------------------------------------------------------------------

# ctm_have_jq : return 0 if jq is on PATH, else 1. No output.
ctm_have_jq() {
  command -v jq >/dev/null 2>&1
}

# ctm_json_get <file> <jq-filter> [default] : echo the value selected by
# <jq-filter> from JSON <file> using jq -r. If the file is missing/unreadable,
# jq is unavailable, the filter errors, or the result is null/empty, echo
# [default] (empty string when omitted). Always returns 0 so callers can use it
# inline without tripping `set -e`.
ctm_json_get() {
  ctm_json_get__file="$1"
  ctm_json_get__filter="$2"
  ctm_json_get__default="${3:-}"
  if [ -z "$ctm_json_get__file" ] || [ ! -f "$ctm_json_get__file" ]; then
    printf '%s' "$ctm_json_get__default"
    return 0
  fi
  if ! ctm_have_jq; then
    printf '%s' "$ctm_json_get__default"
    return 0
  fi
  ctm_json_get__out=$(jq -r "$ctm_json_get__filter" "$ctm_json_get__file" 2>/dev/null)
  if [ $? -ne 0 ] || [ -z "$ctm_json_get__out" ] || [ "$ctm_json_get__out" = "null" ]; then
    printf '%s' "$ctm_json_get__default"
    return 0
  fi
  printf '%s' "$ctm_json_get__out"
  return 0
}

# ctm_json_set <file> <jq-filter> : apply <jq-filter> to JSON <file> in place
# (atomic write via temp file in the same dir). If <file> is missing it is
# seeded with `{}` first. Creates parent dirs. Returns 0 on success, 1 on
# failure (jq missing, jq error, write error); the original file is left
# untouched on failure.
#
# Example: ctm_json_set "$cfg" '.owners["acme"]="auto"'
ctm_json_set() {
  ctm_json_set__file="$1"
  ctm_json_set__filter="$2"
  if [ -z "$ctm_json_set__file" ] || [ -z "$ctm_json_set__filter" ]; then
    return 1
  fi
  if ! ctm_have_jq; then
    ctm_log "ctm_json_set: jq not available"
    return 1
  fi
  ctm_json_set__dir=$(dirname "$ctm_json_set__file")
  mkdir -p "$ctm_json_set__dir" 2>/dev/null || return 1
  if [ ! -f "$ctm_json_set__file" ]; then
    printf '{}\n' >"$ctm_json_set__file" 2>/dev/null || return 1
  fi
  ctm_json_set__tmp="$ctm_json_set__file.tmp.$$"
  if jq "$ctm_json_set__filter" "$ctm_json_set__file" >"$ctm_json_set__tmp" 2>/dev/null; then
    mv "$ctm_json_set__tmp" "$ctm_json_set__file" 2>/dev/null && return 0
    rm -f "$ctm_json_set__tmp" 2>/dev/null
    return 1
  fi
  rm -f "$ctm_json_set__tmp" 2>/dev/null
  return 1
}

# ctm_json_escape <string> : echo <string> as a safe JSON string value,
# INCLUDING the surrounding double quotes (e.g. ctm_json_escape 'a"b' ->
# "a\"b"). Uses jq when available; otherwise a minimal fallback that escapes
# backslash and double-quote. Use for assembling JSON by hand. Always returns 0.
ctm_json_escape() {
  ctm_json_escape__s="$1"
  if ctm_have_jq; then
    printf '%s' "$ctm_json_escape__s" | jq -R -s '.' 2>/dev/null | tr -d '\n'
    return 0
  fi
  # No jq: python3 is the design's second JSON engine and escapes control chars
  # (newlines/tabs) correctly, which the sed fallback below cannot.
  if command -v python3 >/dev/null 2>&1; then
    if printf '%s' "$ctm_json_escape__s" \
         | python3 -c 'import json,sys; sys.stdout.write(json.dumps(sys.stdin.read()))' 2>/dev/null; then
      return 0
    fi
  fi
  # Last-resort fallback (no jq, no python3): escape backslash then double-quote,
  # wrap in quotes. NOTE: does not escape raw control chars, so callers that may
  # pass multi-line text (e.g. the SessionStart index) require jq or python3.
  ctm_json_escape__e=$(printf '%s' "$ctm_json_escape__s" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
  printf '"%s"' "$ctm_json_escape__e"
  return 0
}

# ---------------------------------------------------------------------------
# Git remote URL parsing
# ---------------------------------------------------------------------------

# ctm_parse_remote <url> : parse a git remote URL into "host owner repo"
# (three space-separated fields on one line), where repo has any trailing
# ".git" stripped. Handles:
#   - scp-style  : git@host:owner/repo(.git)            (and host:owner/repo)
#   - https/http : https://host/owner/repo(.git)        (userinfo + port ok)
#   - ssh://     : ssh://git@host(:port)/owner/repo(.git)
#   - git://     : git://host/owner/repo(.git)
# `owner` is the first path segment; `repo` is the LAST segment (extra nested
# path segments between them are ignored for host/owner/repo identity).
# Echoes the empty string and returns 1 if the URL can't be parsed.
ctm_parse_remote() {
  ctm_parse_remote__url="$1"
  ctm_parse_remote__host=""
  ctm_parse_remote__owner=""
  ctm_parse_remote__repo=""
  ctm_parse_remote__rest=""

  if [ -z "$ctm_parse_remote__url" ]; then
    return 1
  fi

  case "$ctm_parse_remote__url" in
    file://*)
      # file:///abs/path/to/repo(.git)  (authority is empty). Treat as a local
      # path: synthesize a stable identity host=local, owner=parent basename,
      # repo=last component.
      ctm_parse_remote__path="${ctm_parse_remote__url#file://}"
      ctm_parse_remote__host="local"
      ctm_parse_remote__repo="${ctm_parse_remote__path##*/}"
      ctm_parse_remote__owner_path="${ctm_parse_remote__path%/*}"
      ctm_parse_remote__owner="${ctm_parse_remote__owner_path##*/}"
      [ -z "$ctm_parse_remote__owner" ] && ctm_parse_remote__owner="local"
      ;;
    /*|./*|../*|~/*)
      # Bare local filesystem path (absolute, ~, or relative). Same synthesis.
      ctm_parse_remote__path="$ctm_parse_remote__url"
      ctm_parse_remote__host="local"
      ctm_parse_remote__repo="${ctm_parse_remote__path##*/}"
      ctm_parse_remote__owner_path="${ctm_parse_remote__path%/*}"
      ctm_parse_remote__owner="${ctm_parse_remote__owner_path##*/}"
      [ -z "$ctm_parse_remote__owner" ] && ctm_parse_remote__owner="local"
      ;;
    *://*)
      # scheme://[userinfo@]host[:port]/owner/.../repo
      # Strip scheme.
      ctm_parse_remote__rest="${ctm_parse_remote__url#*://}"
      # Strip userinfo (everything up to and including a '@' that appears
      # before the first '/').
      case "$ctm_parse_remote__rest" in
        */*)
          ctm_parse_remote__authority="${ctm_parse_remote__rest%%/*}"
          ctm_parse_remote__path="/${ctm_parse_remote__rest#*/}"
          ;;
        *)
          # No path at all.
          return 1
          ;;
      esac
      # authority may contain userinfo@host:port
      case "$ctm_parse_remote__authority" in
        *@*) ctm_parse_remote__hostport="${ctm_parse_remote__authority##*@}" ;;
        *)   ctm_parse_remote__hostport="$ctm_parse_remote__authority" ;;
      esac
      # Strip port.
      ctm_parse_remote__host="${ctm_parse_remote__hostport%%:*}"
      # path begins with '/'; drop leading slashes.
      ctm_parse_remote__p="$ctm_parse_remote__path"
      while [ "${ctm_parse_remote__p#/}" != "$ctm_parse_remote__p" ]; do
        ctm_parse_remote__p="${ctm_parse_remote__p#/}"
      done
      # owner = first segment, repo = last segment.
      ctm_parse_remote__owner="${ctm_parse_remote__p%%/*}"
      ctm_parse_remote__repo="${ctm_parse_remote__p##*/}"
      ;;
    *@*:*)
      # scp-style: [user@]host:owner/.../repo
      ctm_parse_remote__userhost="${ctm_parse_remote__url%%:*}"
      ctm_parse_remote__path="${ctm_parse_remote__url#*:}"
      # Strip user@ from host part.
      case "$ctm_parse_remote__userhost" in
        *@*) ctm_parse_remote__host="${ctm_parse_remote__userhost##*@}" ;;
        *)   ctm_parse_remote__host="$ctm_parse_remote__userhost" ;;
      esac
      ctm_parse_remote__p="$ctm_parse_remote__path"
      while [ "${ctm_parse_remote__p#/}" != "$ctm_parse_remote__p" ]; do
        ctm_parse_remote__p="${ctm_parse_remote__p#/}"
      done
      ctm_parse_remote__owner="${ctm_parse_remote__p%%/*}"
      ctm_parse_remote__repo="${ctm_parse_remote__p##*/}"
      ;;
    *:*/*)
      # bare scp-style without user: host:owner/repo
      ctm_parse_remote__host="${ctm_parse_remote__url%%:*}"
      ctm_parse_remote__path="${ctm_parse_remote__url#*:}"
      ctm_parse_remote__p="$ctm_parse_remote__path"
      while [ "${ctm_parse_remote__p#/}" != "$ctm_parse_remote__p" ]; do
        ctm_parse_remote__p="${ctm_parse_remote__p#/}"
      done
      ctm_parse_remote__owner="${ctm_parse_remote__p%%/*}"
      ctm_parse_remote__repo="${ctm_parse_remote__p##*/}"
      ;;
    *)
      return 1
      ;;
  esac

  # Strip trailing .git from repo.
  case "$ctm_parse_remote__repo" in
    *.git) ctm_parse_remote__repo="${ctm_parse_remote__repo%.git}" ;;
  esac

  if [ -z "$ctm_parse_remote__host" ] || [ -z "$ctm_parse_remote__owner" ] || [ -z "$ctm_parse_remote__repo" ]; then
    return 1
  fi
  # owner and repo must differ if there was only one segment we'd have failed;
  # guard the single-segment case where owner==repo because path had no slash.
  if [ "$ctm_parse_remote__owner" = "$ctm_parse_remote__repo" ]; then
    case "$ctm_parse_remote__path" in
      */*) : ;;            # had a slash; legitimately owner/repo with same names is impossible here, accept
      *) return 1 ;;       # no slash -> not owner/repo
    esac
  fi

  printf '%s %s %s' "$ctm_parse_remote__host" "$ctm_parse_remote__owner" "$ctm_parse_remote__repo"
  return 0
}

# ctm_remote_field <url> <host|owner|repo> : convenience accessor; echoes one
# parsed field from ctm_parse_remote. Echoes empty and returns 1 on parse
# failure or unknown field name.
ctm_remote_field() {
  ctm_remote_field__parsed=$(ctm_parse_remote "$1") || return 1
  ctm_remote_field__host="${ctm_remote_field__parsed%% *}"
  ctm_remote_field__tail="${ctm_remote_field__parsed#* }"
  ctm_remote_field__owner="${ctm_remote_field__tail%% *}"
  ctm_remote_field__repo="${ctm_remote_field__tail##* }"
  case "$2" in
    host)  printf '%s' "$ctm_remote_field__host" ;;
    owner) printf '%s' "$ctm_remote_field__owner" ;;
    repo)  printf '%s' "$ctm_remote_field__repo" ;;
    *)     return 1 ;;
  esac
  return 0
}

# ---------------------------------------------------------------------------
# Current project introspection
# ---------------------------------------------------------------------------

# ctm_project_root [dir] : echo the absolute path of the git toplevel for [dir]
# (default: cwd). Echoes empty and returns 1 if not in a git work tree.
ctm_project_root() {
  ctm_project_root__dir="${1:-$PWD}"
  ctm_project_root__top=$(git -C "$ctm_project_root__dir" rev-parse --show-toplevel 2>/dev/null)
  if [ $? -ne 0 ] || [ -z "$ctm_project_root__top" ]; then
    return 1
  fi
  printf '%s' "$ctm_project_root__top"
  return 0
}

# ctm_project_origin_url [dir] : echo the `origin` remote fetch URL for the git
# repo at [dir] (default: cwd). Echoes empty and returns 1 if there is no repo
# or no `origin` remote.
ctm_project_origin_url() {
  ctm_project_origin_url__dir="${1:-$PWD}"
  ctm_project_origin_url__u=$(git -C "$ctm_project_origin_url__dir" remote get-url origin 2>/dev/null)
  if [ $? -ne 0 ] || [ -z "$ctm_project_origin_url__u" ]; then
    return 1
  fi
  printf '%s' "$ctm_project_origin_url__u"
  return 0
}

# ctm_project_key [dir] : echo the project key "<owner>/<repo>" derived from the
# origin remote of the git repo at [dir] (default: cwd). This is the subtree key
# inside the storage repo. Echoes empty and returns 1 if origin is missing or
# unparseable.
ctm_project_key() {
  ctm_project_key__url=$(ctm_project_origin_url "${1:-$PWD}") || return 1
  ctm_project_key__parsed=$(ctm_parse_remote "$ctm_project_key__url") || return 1
  ctm_project_key__tail="${ctm_project_key__parsed#* }"   # drop host
  ctm_project_key__owner="${ctm_project_key__tail%% *}"
  ctm_project_key__repo="${ctm_project_key__tail##* }"
  printf '%s/%s' "$ctm_project_key__owner" "$ctm_project_key__repo"
  return 0
}

# ctm_project_owner [dir] : echo just the owner (org) of the current project's
# origin. Echoes empty and returns 1 on failure. Used as the config lookup key.
ctm_project_owner() {
  ctm_project_owner__url=$(ctm_project_origin_url "${1:-$PWD}") || return 1
  ctm_remote_field "$ctm_project_owner__url" owner
}

# ---------------------------------------------------------------------------
# Storage checkout path
# ---------------------------------------------------------------------------

# ctm_storage_id <host> <owner> <repo> : echo the storage-repo identity slug
# "<host>__<owner>__<repo>" used as the checkout directory name. Returns 1 if
# any field is empty.
ctm_storage_id() {
  if [ -z "$1" ] || [ -z "$2" ] || [ -z "$3" ]; then
    return 1
  fi
  printf '%s__%s__%s' "$1" "$2" "$3"
  return 0
}

# ctm_checkout_dir <host> <owner> <repo> : echo the absolute checkout directory
# for a storage repo: <data-dir>/repos/<host>__<owner>__<repo>. Returns 1 if
# any field is empty.
ctm_checkout_dir() {
  ctm_checkout_dir__id=$(ctm_storage_id "$1" "$2" "$3") || return 1
  printf '%s/%s' "$(ctm_repos_dir)" "$ctm_checkout_dir__id"
  return 0
}

# ctm_checkout_dir_from_url <storage-url> : echo the absolute checkout directory
# for a storage repo given its git URL (parses the URL first). Echoes empty and
# returns 1 if the URL can't be parsed.
ctm_checkout_dir_from_url() {
  ctm_checkout_dir_from_url__parsed=$(ctm_parse_remote "$1") || return 1
  ctm_checkout_dir_from_url__host="${ctm_checkout_dir_from_url__parsed%% *}"
  ctm_checkout_dir_from_url__tail="${ctm_checkout_dir_from_url__parsed#* }"
  ctm_checkout_dir_from_url__owner="${ctm_checkout_dir_from_url__tail%% *}"
  ctm_checkout_dir_from_url__repo="${ctm_checkout_dir_from_url__tail##* }"
  ctm_checkout_dir "$ctm_checkout_dir_from_url__host" "$ctm_checkout_dir_from_url__owner" "$ctm_checkout_dir_from_url__repo"
}

# ctm_target_memory_dir <checkout-dir> <project-key> : echo the per-project
# memory subtree inside a checkout: <checkout-dir>/<project-key>/memory.
# Returns 1 if either argument is empty.
ctm_target_memory_dir() {
  if [ -z "$1" ] || [ -z "$2" ]; then
    return 1
  fi
  printf '%s/%s/memory' "${1%/}" "$2"
  return 0
}

# ---------------------------------------------------------------------------
# Native memory dir location (DESIGN §11.2)
# ---------------------------------------------------------------------------

# ctm_native_slug <project-root-abspath> : echo the native-dir slug for a
# project root: the absolute path with every "/" and "." replaced by "-".
# Returns 1 if the argument is empty.
ctm_native_slug() {
  if [ -z "$1" ]; then
    return 1
  fi
  printf '%s' "$1" | sed -e 's#[/.]#-#g'
  return 0
}

# ctm_native_memory_dir <project-root-abspath> : echo the native memory
# directory for a project root:
#   $HOME/.claude/projects/<slug>/memory
# where <slug> is ctm_native_slug. This is a DERIVED path; it is NOT guaranteed
# to exist (the caller checks). The claude home base honors CLAUDE_CONFIG_DIR
# when set, else $HOME/.claude. Returns 1 if the argument is empty.
ctm_native_memory_dir() {
  if [ -z "$1" ]; then
    return 1
  fi
  ctm_native_memory_dir__slug=$(ctm_native_slug "$1") || return 1
  if [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then
    ctm_native_memory_dir__base="${CLAUDE_CONFIG_DIR%/}"
  else
    ctm_native_memory_dir__base="$HOME/.claude"
  fi
  printf '%s/projects/%s/memory' "$ctm_native_memory_dir__base" "$ctm_native_memory_dir__slug"
  return 0
}

# ---------------------------------------------------------------------------
# Anti-circular guard (DESIGN §3.3, §8.4)
# ---------------------------------------------------------------------------

# ctm_urls_same_repo <url-a> <url-b> : return 0 if the two git URLs identify the
# SAME repo (same host + owner + repo, ignoring protocol, userinfo, port, and a
# trailing .git), else 1. If either URL can't be parsed, returns 1 (treated as
# "not the same"). No stdout.
ctm_urls_same_repo() {
  ctm_urls_same_repo__a=$(ctm_parse_remote "$1") || return 1
  ctm_urls_same_repo__b=$(ctm_parse_remote "$2") || return 1
  if [ "$ctm_urls_same_repo__a" = "$ctm_urls_same_repo__b" ]; then
    return 0
  fi
  return 1
}

# ctm_path_inside <child> <parent> : return 0 if absolute path <child> is equal
# to or nested under absolute path <parent>, else 1. Pure string prefix test on
# normalized (trailing-slash-stripped) paths; does not touch the filesystem. No
# stdout.
ctm_path_inside() {
  ctm_path_inside__child="${1%/}"
  ctm_path_inside__parent="${2%/}"
  if [ -z "$ctm_path_inside__child" ] || [ -z "$ctm_path_inside__parent" ]; then
    return 1
  fi
  if [ "$ctm_path_inside__child" = "$ctm_path_inside__parent" ]; then
    return 0
  fi
  case "$ctm_path_inside__child" in
    "$ctm_path_inside__parent"/*) return 0 ;;
    *) return 1 ;;
  esac
}

# ctm_is_circular <candidate-storage-url> [project-dir] : return 0 (CIRCULAR ->
# the plugin must disable) when EITHER:
#   (a) the candidate storage URL identifies the same repo as the current
#       project's origin remote, OR
#   (b) [project-dir] (default: cwd) is inside any checkout under
#       <data-dir>/repos/.
# Returns 1 when not circular. Echoes a short human-readable reason to stdout
# ONLY when circular (empty otherwise) so callers can surface it; the return
# code is authoritative.
ctm_is_circular() {
  ctm_is_circular__url="$1"
  ctm_is_circular__dir="${2:-$PWD}"

  # (a) candidate == project origin
  ctm_is_circular__origin=$(ctm_project_origin_url "$ctm_is_circular__dir" 2>/dev/null)
  if [ -n "$ctm_is_circular__origin" ] && [ -n "$ctm_is_circular__url" ]; then
    if ctm_urls_same_repo "$ctm_is_circular__url" "$ctm_is_circular__origin"; then
      printf '%s' "storage repo equals the current project origin"
      return 0
    fi
  fi

  # (b) cwd inside any plugin-data checkout
  if ctm_path_inside "$ctm_is_circular__dir" "$(ctm_repos_dir)"; then
    printf '%s' "current directory is inside a plugin-data checkout"
    return 0
  fi

  return 1
}

# ---------------------------------------------------------------------------
# "auto" storage URL synthesis
# ---------------------------------------------------------------------------

# ctm_auto_storage_url <project-origin-url> [repo-name] [owner-override] :
# given the project's origin URL, synthesize a storage repo URL on the SAME host
# and protocol (preserving userinfo/port). [repo-name] defaults to
# "claude-team-memory"; the owner defaults to the project's own owner but can be
# overridden with [owner-override] (used by the config "owner/repo" form). E.g.:
#   git@github.com:acme/app.git        -> git@github.com:acme/claude-team-memory.git
#   https://github.com/acme/app.git    -> https://github.com/acme/claude-team-memory.git
#   ssh://git@host:22/acme/app(.git)   -> ssh://git@host:22/acme/claude-team-memory.git
#   (origin git@github.com:acme/app, repo=mem, owner=globex)
#                                       -> git@github.com:globex/mem.git
# Echoes empty and returns 1 if the project origin can't be parsed.
ctm_auto_storage_url() {
  ctm_auto_storage_url__origin="$1"
  ctm_auto_storage_url__repo="${2:-claude-team-memory}"
  ctm_auto_storage_url__owner_override="${3:-}"
  ctm_auto_storage_url__parsed=$(ctm_parse_remote "$ctm_auto_storage_url__origin") || return 1
  ctm_auto_storage_url__host="${ctm_auto_storage_url__parsed%% *}"
  ctm_auto_storage_url__tail="${ctm_auto_storage_url__parsed#* }"
  ctm_auto_storage_url__owner="${ctm_auto_storage_url__tail%% *}"
  if [ -n "$ctm_auto_storage_url__owner_override" ]; then
    ctm_auto_storage_url__owner="$ctm_auto_storage_url__owner_override"
  fi

  case "$ctm_auto_storage_url__origin" in
    ssh://*|https://*|http://*|git://*)
      # Preserve scheme + authority (userinfo/port), replace the path.
      ctm_auto_storage_url__scheme="${ctm_auto_storage_url__origin%%://*}"
      ctm_auto_storage_url__rest="${ctm_auto_storage_url__origin#*://}"
      ctm_auto_storage_url__authority="${ctm_auto_storage_url__rest%%/*}"
      printf '%s://%s/%s/%s.git' "$ctm_auto_storage_url__scheme" "$ctm_auto_storage_url__authority" "$ctm_auto_storage_url__owner" "$ctm_auto_storage_url__repo"
      ;;
    *@*:*|*:*/*)
      # scp-style: preserve user@host (the part before the first ':').
      ctm_auto_storage_url__userhost="${ctm_auto_storage_url__origin%%:*}"
      printf '%s:%s/%s.git' "$ctm_auto_storage_url__userhost" "$ctm_auto_storage_url__owner" "$ctm_auto_storage_url__repo"
      ;;
    *)
      return 1
      ;;
  esac
  return 0
}

# ctm_normalize_config_value <raw-value> <project-origin-url> : turn a config
# owners-map value into a concrete git URL. Rules:
#   - "auto"                  -> ctm_auto_storage_url(project-origin)
#   - "owner/repo"            -> same host+protocol as project, that owner/repo
#   - a full git URL (contains "://" or "@host:" or "host:owner/")  -> as-is
# Echoes the resolved URL; returns 1 if it cannot resolve (e.g. "auto" or
# "owner/repo" given but the project origin is unparseable).
ctm_normalize_config_value() {
  ctm_normalize_config_value__raw="$1"
  ctm_normalize_config_value__origin="$2"

  if [ -z "$ctm_normalize_config_value__raw" ]; then
    return 1
  fi

  if [ "$ctm_normalize_config_value__raw" = "auto" ]; then
    ctm_auto_storage_url "$ctm_normalize_config_value__origin"
    return $?
  fi

  # Full git URL forms, and local filesystem paths (absolute / ~ / relative /
  # file://) — all used verbatim.
  case "$ctm_normalize_config_value__raw" in
    *://*|*@*:*|/*|./*|../*|~/*)
      printf '%s' "$ctm_normalize_config_value__raw"
      return 0
      ;;
  esac

  # "owner/repo" (exactly one slash, no scheme/host) -> synthesize on the
  # project's host+protocol with this explicit owner + repo.
  case "$ctm_normalize_config_value__raw" in
    */*)
      ctm_normalize_config_value__owner="${ctm_normalize_config_value__raw%%/*}"
      ctm_normalize_config_value__repo="${ctm_normalize_config_value__raw##*/}"
      case "$ctm_normalize_config_value__repo" in
        *.git) ctm_normalize_config_value__repo="${ctm_normalize_config_value__repo%.git}" ;;
      esac
      ctm_auto_storage_url "$ctm_normalize_config_value__origin" "$ctm_normalize_config_value__repo" "$ctm_normalize_config_value__owner"
      return $?
      ;;
  esac

  # Anything else: treat as a bare value we can't safely interpret.
  return 1
}

# ---------------------------------------------------------------------------
# Checkout maintenance
# ---------------------------------------------------------------------------

# ctm_ensure_checkout <storage-url> <checkout-dir> : ensure <checkout-dir> is a
# git checkout of <storage-url>. If the dir already contains a git repo, this is
# a no-op (returns 0 WITHOUT pulling — refresh is the caller's job). If absent,
# clone ONCE (synchronous, full history — a shallow clone would break the later
# pull --rebase / --ff-only; memory repos are tiny so full history is cheap).
# Returns 0 on success (already-present or freshly cloned), 1 on clone failure.
# Diagnostics go to
# stderr. On clone failure any partial dir is removed.
ctm_ensure_checkout() {
  ctm_ensure_checkout__url="$1"
  ctm_ensure_checkout__dir="$2"
  if [ -z "$ctm_ensure_checkout__url" ] || [ -z "$ctm_ensure_checkout__dir" ]; then
    return 1
  fi
  if [ -d "$ctm_ensure_checkout__dir/.git" ]; then
    return 0
  fi
  mkdir -p "$(dirname "$ctm_ensure_checkout__dir")" 2>/dev/null || return 1
  ctm_log "cloning storage repo into $ctm_ensure_checkout__dir"
  # This clone runs SYNCHRONOUSLY on the first session for a configured repo
  # (resolve-repo.sh calls us before load.sh emits anything). git must therefore
  # NEVER block on an interactive credential or host-key prompt, or it would hang
  # session start (violating the SessionStart "never blocks" contract). Force
  # non-interactive failure instead: GIT_TERMINAL_PROMPT=0 disables HTTPS cred
  # prompts; the BatchMode ssh command disables SSH password/passphrase prompts
  # and bounds the TCP connect; accept-new auto-trusts an unknown host key rather
  # than prompting. On any of these, git fails fast and we degrade to disabled.
  if GIT_TERMINAL_PROMPT=0 \
     GIT_SSH_COMMAND="ssh -oBatchMode=yes -oConnectTimeout=5 -oStrictHostKeyChecking=accept-new" \
     git clone "$ctm_ensure_checkout__url" "$ctm_ensure_checkout__dir" >/dev/null 2>&1; then
    return 0
  fi
  ctm_log "clone failed for $ctm_ensure_checkout__url"
  # Clean up a partial/empty checkout so a later run can retry cleanly.
  if [ -d "$ctm_ensure_checkout__dir" ] && [ ! -d "$ctm_ensure_checkout__dir/.git" ]; then
    rm -rf "$ctm_ensure_checkout__dir" 2>/dev/null
  fi
  return 1
}
