#!/bin/bash
# resolve-repo.sh — resolve the storage repo for the CURRENT project and print a
# single JSON object describing the resolution. Safe to run directly or source.
#
# Resolution order (DESIGN §3):
#   1. env CLAUDE_TEAM_MEMORY_REPO   (full git URL or "owner/repo") — override.
#   2. config <data-dir>/config.json owners[<project-owner>]:
#        "auto"            -> <host>:<owner>/claude-team-memory (project host+proto)
#        "owner/repo"      -> same host+proto, that owner/repo
#        full git URL      -> as-is
#      miss -> disabled.
#   3. Anti-circular guard on top (storage == project origin, or cwd inside a
#      plugin-data checkout) -> disabled.
#
# When ENABLED: ensure the checkout exists (clone ONCE if absent; never pull
# here — load.sh refreshes). Then print, to stdout, ONE JSON object with keys:
#   enabled, reason, storageUrl, checkoutDir, projectKey, targetMemoryDir,
#   nativeMemoryDir.
# On any error or when disabled, print {"enabled":false,"reason":"..."} and
# exit 0. The hook path must never see a non-zero exit.

# --- locate and source lib.sh (self-locating via CLAUDE_PLUGIN_ROOT) ---------
ctm__self="${BASH_SOURCE[0]:-$0}"
ctm__self_dir=$(CDPATH= cd -- "$(dirname -- "$ctm__self")" 2>/dev/null && pwd)
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "${CLAUDE_PLUGIN_ROOT}/scripts/lib.sh" ]; then
  . "${CLAUDE_PLUGIN_ROOT}/scripts/lib.sh"
elif [ -n "$ctm__self_dir" ] && [ -f "$ctm__self_dir/lib.sh" ]; then
  . "$ctm__self_dir/lib.sh"
else
  printf '{"enabled":false,"reason":"cannot locate lib.sh"}\n'
  return 0 2>/dev/null || exit 0
fi

# --- emit a disabled result then stop (return if sourced, else exit) ---------
ctm_resolve_disabled() {
  if ctm_have_jq; then
    jq -n --arg reason "$1" '{enabled:false, reason:$reason}'
  else
    printf '{"enabled":false,"reason":%s}\n' "$(ctm_json_escape "$1")"
  fi
  return 0 2>/dev/null || exit 0
}

# --- emit an enabled result then stop ---------------------------------------
ctm_resolve_enabled() {
  # args: reason storageUrl checkoutDir projectKey targetMemoryDir nativeMemoryDir
  if ctm_have_jq; then
    jq -n \
      --arg reason "$1" \
      --arg storageUrl "$2" \
      --arg checkoutDir "$3" \
      --arg projectKey "$4" \
      --arg targetMemoryDir "$5" \
      --arg nativeMemoryDir "$6" \
      '{enabled:true, reason:$reason, storageUrl:$storageUrl, checkoutDir:$checkoutDir, projectKey:$projectKey, targetMemoryDir:$targetMemoryDir, nativeMemoryDir:$nativeMemoryDir}'
  else
    printf '{"enabled":true,"reason":%s,"storageUrl":%s,"checkoutDir":%s,"projectKey":%s,"targetMemoryDir":%s,"nativeMemoryDir":%s}\n' \
      "$(ctm_json_escape "$1")" \
      "$(ctm_json_escape "$2")" \
      "$(ctm_json_escape "$3")" \
      "$(ctm_json_escape "$4")" \
      "$(ctm_json_escape "$5")" \
      "$(ctm_json_escape "$6")"
  fi
  return 0 2>/dev/null || exit 0
}

# --- main resolution ---------------------------------------------------------
ctm_resolve_main() {
  ctm_resolve_main__dir="${1:-$PWD}"

  # Early structural guard (anti-circular part b): if cwd is inside any
  # plugin-data checkout, disable before doing anything else — independent of
  # whether a project key can be derived (DESIGN §3.3, §8.4).
  if ctm_path_inside "$ctm_resolve_main__dir" "$(ctm_repos_dir)"; then
    ctm_resolve_disabled "circular: current directory is inside a plugin-data checkout"
    return 0
  fi

  # Need a git project with an origin to do anything meaningful.
  ctm_resolve_main__root=$(ctm_project_root "$ctm_resolve_main__dir")
  if [ -z "$ctm_resolve_main__root" ]; then
    ctm_resolve_disabled "not inside a git repository"
    return 0
  fi

  ctm_resolve_main__origin=$(ctm_project_origin_url "$ctm_resolve_main__root")
  if [ -z "$ctm_resolve_main__origin" ]; then
    ctm_resolve_disabled "project has no origin remote"
    return 0
  fi

  ctm_resolve_main__key=$(ctm_project_key "$ctm_resolve_main__root")
  if [ -z "$ctm_resolve_main__key" ]; then
    ctm_resolve_disabled "could not derive <org>/<repo> from origin remote"
    return 0
  fi

  ctm_resolve_main__owner="${ctm_resolve_main__key%%/*}"
  ctm_resolve_main__native=$(ctm_native_memory_dir "$ctm_resolve_main__root")

  # --- step 1: env override --------------------------------------------------
  ctm_resolve_main__storage=""
  ctm_resolve_main__source=""
  if [ -n "${CLAUDE_TEAM_MEMORY_REPO:-}" ]; then
    ctm_resolve_main__storage=$(ctm_normalize_config_value "$CLAUDE_TEAM_MEMORY_REPO" "$ctm_resolve_main__origin")
    if [ -z "$ctm_resolve_main__storage" ]; then
      ctm_resolve_disabled "CLAUDE_TEAM_MEMORY_REPO is set but could not be resolved to a git URL"
      return 0
    fi
    ctm_resolve_main__source="env CLAUDE_TEAM_MEMORY_REPO"
  else
    # --- step 2: config lookup by owner -------------------------------------
    ctm_resolve_main__cfg=$(ctm_config_path)
    ctm_resolve_main__raw=$(ctm_json_get "$ctm_resolve_main__cfg" ".owners[\"$ctm_resolve_main__owner\"]" "")
    if [ -z "$ctm_resolve_main__raw" ]; then
      ctm_resolve_disabled "owner '$ctm_resolve_main__owner' not configured in $ctm_resolve_main__cfg"
      return 0
    fi
    ctm_resolve_main__storage=$(ctm_normalize_config_value "$ctm_resolve_main__raw" "$ctm_resolve_main__origin")
    if [ -z "$ctm_resolve_main__storage" ]; then
      ctm_resolve_disabled "config value for owner '$ctm_resolve_main__owner' could not be resolved to a git URL"
      return 0
    fi
    ctm_resolve_main__source="config owners[$ctm_resolve_main__owner]"
  fi

  # --- step 3: anti-circular guard ------------------------------------------
  ctm_resolve_main__circ=$(ctm_is_circular "$ctm_resolve_main__storage" "$ctm_resolve_main__dir")
  if [ $? -eq 0 ]; then
    ctm_resolve_disabled "circular: $ctm_resolve_main__circ"
    return 0
  fi

  # --- compute paths ---------------------------------------------------------
  ctm_resolve_main__checkout=$(ctm_checkout_dir_from_url "$ctm_resolve_main__storage")
  if [ -z "$ctm_resolve_main__checkout" ]; then
    ctm_resolve_disabled "could not compute checkout dir from storage URL"
    return 0
  fi
  ctm_resolve_main__target=$(ctm_target_memory_dir "$ctm_resolve_main__checkout" "$ctm_resolve_main__key")

  # --- ensure the checkout (clone once; do NOT pull) ------------------------
  if ! ctm_ensure_checkout "$ctm_resolve_main__storage" "$ctm_resolve_main__checkout"; then
    ctm_resolve_disabled "could not clone storage repo (resolved from $ctm_resolve_main__source)"
    return 0
  fi

  ctm_resolve_enabled \
    "resolved from $ctm_resolve_main__source" \
    "$ctm_resolve_main__storage" \
    "$ctm_resolve_main__checkout" \
    "$ctm_resolve_main__key" \
    "$ctm_resolve_main__target" \
    "$ctm_resolve_main__native"
  return 0
}

ctm_resolve_main "$PWD"
