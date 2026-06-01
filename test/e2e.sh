#!/bin/bash
# e2e.sh — isolated, OFFLINE end-to-end test for claude-team-mem (DESIGN §12.7).
#
# This test exercises the SHELL-SCRIPT mechanics of the plugin against the REAL
# scripts in ${CLAUDE_PLUGIN_ROOT}/scripts. It touches NO network and NO real
# org/repo and NEVER writes to the real ~/.claude or ~/.claude-team-mem:
#
#   - A single `mktemp -d` root T holds everything.
#   - HOME              -> $T/home   (so ~/.claude is sandboxed)
#   - CLAUDE_PLUGIN_DATA -> $T/data  (config + checkouts sandboxed)
#   - CLAUDE_PLUGIN_ROOT -> the plugin repo (scripts under test)
#   - A BARE git repo at $T/remote/acme/claude-team-memory.git is the storage
#     "remote", reachable via a file:// URL (fully offline). It is pre-seeded
#     with a teammate file to simulate a colleague's shared memory.
#   - A fake project at $T/proj/app has origin git@github.com:acme/app.git (so it
#     parses as owner=acme, repo=app) but config points owner "acme" at the LOCAL
#     bare repo's file:// URL so the clone works offline.
#
# Out of scope (covered by the review phase, not here): skill-level Claude
# reasoning — classification wording, sanitization, semantic merge. Where a
# scenario depends on that reasoning, we drive publish.sh with pre-prepared
# inputs (the skill's contract: it writes the final bytes into the checkout,
# publish.sh does the git mechanics).
#
# macOS /bin/bash 3.2 compatible. Run:  bash test/e2e.sh
# Exits non-zero on ANY assertion failure; prints "PASSED: x/y" at the end.

# Deliberately NOT `set -e`: we want every assertion to run and be tallied even
# when an earlier one fails. We track failures explicitly.

# ===========================================================================
# Isolation: build the throwaway world. Do this FIRST, before anything reads
# HOME / CLAUDE_PLUGIN_DATA.
# ===========================================================================
CTM_ROOT_REPO="/Users/fuyaoz/sentio-ws/claude-team-mem"

T=$(mktemp -d 2>/dev/null) || { echo "FATAL: mktemp -d failed"; exit 1; }

# Hermetic env. Unset anything that could leak the developer's real config in.
export HOME="$T/home"
export CLAUDE_PLUGIN_DATA="$T/data"
export CLAUDE_PLUGIN_ROOT="$CTM_ROOT_REPO"
unset CLAUDE_CONFIG_DIR
unset CLAUDE_TEAM_MEMORY_REPO
export GIT_TERMINAL_PROMPT=0          # never prompt for credentials (offline)
export GIT_CONFIG_NOSYSTEM=1          # ignore /etc/gitconfig
# Give git a clean, self-contained global config inside the sandbox HOME so
# clones/commits never read or write the developer's real ~/.gitconfig.
mkdir -p "$HOME"
export GIT_AUTHOR_NAME="e2e-tester"
export GIT_AUTHOR_EMAIL="e2e@localhost"
export GIT_COMMITTER_NAME="e2e-tester"
export GIT_COMMITTER_EMAIL="e2e@localhost"

SCRIPTS="$CLAUDE_PLUGIN_ROOT/scripts"

# Clean up the whole sandbox on exit (success or failure).
ctm_cleanup() { [ -n "$T" ] && rm -rf "$T" 2>/dev/null; }
trap ctm_cleanup EXIT INT TERM

# ===========================================================================
# Tiny assertion harness.
# ===========================================================================
PASS=0
FAIL=0
CURRENT=""   # label of the scenario currently running, for context in output

section() {
  CURRENT="$1"
  printf '\n=== %s ===\n' "$1"
}

ok() {   # ok <description>
  PASS=$((PASS + 1))
  printf '  PASS: %s\n' "$1"
}

bad() {  # bad <description> [detail...]
  FAIL=$((FAIL + 1))
  printf '  FAIL: %s\n' "$1"
  shift
  if [ $# -gt 0 ]; then
    for ctm_d in "$@"; do printf '        %s\n' "$ctm_d"; done
  fi
}

assert_eq() {        # assert_eq <desc> <expected> <actual>
  if [ "$2" = "$3" ]; then ok "$1"; else
    bad "$1" "expected: [$2]" "actual:   [$3]"
  fi
}

assert_contains() {  # assert_contains <desc> <haystack> <needle>
  case "$2" in
    *"$3"*) ok "$1" ;;
    *) bad "$1" "needle:   [$3]" "haystack: [$2]" ;;
  esac
}

assert_not_contains() {  # assert_not_contains <desc> <haystack> <needle>
  case "$2" in
    *"$3"*) bad "$1" "unexpected needle present: [$3]" "haystack: [$2]" ;;
    *) ok "$1" ;;
  esac
}

assert_symlink() {   # assert_symlink <desc> <path>
  if [ -L "$2" ]; then ok "$1"; else bad "$1" "not a symlink: $2"; fi
}

assert_real_file() { # assert_real_file <desc> <path> : a regular file, NOT a symlink
  if [ -f "$2" ] && [ ! -L "$2" ]; then ok "$1"; else
    bad "$1" "not a real (non-symlink) file: $2"
  fi
}

assert_exists() {    # assert_exists <desc> <path>
  if [ -e "$2" ] || [ -L "$2" ]; then ok "$1"; else bad "$1" "missing: $2"; fi
}

assert_absent() {    # assert_absent <desc> <path>
  if [ -e "$2" ] || [ -L "$2" ]; then bad "$1" "should not exist: $2"; else ok "$1"; fi
}

# json <json-string> <jq-filter> : echo the extracted value (empty on error).
json() { printf '%s' "$1" | jq -r "$2" 2>/dev/null; }

# Source lib.sh once so the test can call helpers directly (e.g. ctm_native_slug,
# ctm_auto_storage_url) — same library the scripts use.
. "$SCRIPTS/lib.sh"

# native_dir_for <project-abspath> : the native memory dir the plugin derives,
# computed INDEPENDENTLY of lib.sh by re-implementing the documented slug rule,
# so the test pins the rule rather than trusting the code it tests.
native_dir_for() {
  ctm_nd__slug=$(printf '%s' "$1" | sed -e 's#[/.]#-#g')
  printf '%s/.claude/projects/%s/memory' "$HOME" "$ctm_nd__slug"
}

# ===========================================================================
# Build the storage remote (bare) + pre-seed a teammate file (offline).
# ===========================================================================
REMOTE_DIR="$T/remote/acme/claude-team-memory.git"
mkdir -p "$T/remote/acme"
git init --bare -b main -q "$REMOTE_DIR" || { echo "FATAL: cannot init bare remote"; exit 1; }
STORAGE_URL="file://$REMOTE_DIR"

# Seed the remote with a teammate's shared memory by cloning, committing, pushing
# (all offline). Project subtree is keyed <org>/<repo> = acme/app.
SEED="$T/seed"
git clone -q "$STORAGE_URL" "$SEED" 2>/dev/null
mkdir -p "$SEED/acme/app/memory"
cat > "$SEED/acme/app/memory/teammate-note.md" <<'EOF'
---
name: Teammate Deploy Note
description: how the team deploys the app
metadata:
  type: project
  scope: team
  origin: team
---
The team deploys via the blue-green pipeline. Verify the health check first.
EOF
git -C "$SEED" add -A >/dev/null 2>&1
git -C "$SEED" commit -q -m "seed: teammate note" >/dev/null 2>&1
git -C "$SEED" push -q origin main >/dev/null 2>&1 || { echo "FATAL: cannot seed remote"; exit 1; }

# ===========================================================================
# Build the fake project: origin github.com:acme/app, but config -> local bare.
# ===========================================================================
PROJ="$T/proj/app"
mkdir -p "$PROJ"
git init -q -b main "$PROJ"
git -C "$PROJ" remote add origin "git@github.com:acme/app.git"
PROJ_ROOT=$(git -C "$PROJ" rev-parse --show-toplevel 2>/dev/null)
NATIVE="$(native_dir_for "$PROJ_ROOT")"

# Config: owner "acme" -> the LOCAL bare repo (file:// URL) so clone is offline.
mkdir -p "$CLAUDE_PLUGIN_DATA"
cat > "$CLAUDE_PLUGIN_DATA/config.json" <<EOF
{
  "owners": {
    "acme": "$STORAGE_URL"
  },
  "maxIndexBytes": 20000
}
EOF

# Expected derived paths (independent of resolve-repo.sh output).
EXP_PROJECT_KEY="acme/app"
EXP_CHECKOUT="$CLAUDE_PLUGIN_DATA/repos/local__acme__claude-team-memory"
EXP_TARGET="$EXP_CHECKOUT/acme/app/memory"

# Seed the NATIVE dir with real files: one team-type, one personal/user-type.
# These are genuine native memory files (frontmatter + body), pre-existing on
# this machine before any sync.
mkdir -p "$NATIVE"
cat > "$NATIVE/my-prefs.md" <<'EOF'
---
name: My Editor Prefs
description: personal editor + shell preferences on this machine
metadata:
  type: user
  scope: personal
---
I use 2-space indents and zsh. This never leaves my machine.
EOF
cat > "$NATIVE/api-shape.md" <<'EOF'
---
name: API Shape
description: the public REST surface of the app
metadata:
  type: project
  scope: team
---
GET /v1/things returns a paginated list.
EOF

# ===========================================================================
# 1) Syntax: bash -n on every script.
# ===========================================================================
section "1. syntax (bash -n) on every script"
for ctm_s in lib.sh resolve-repo.sh load.sh publish.sh unshare.sh; do
  if [ -f "$SCRIPTS/$ctm_s" ]; then
    if bash -n "$SCRIPTS/$ctm_s" 2>/tmp/.ctm_syn.$$; then
      ok "bash -n $ctm_s"
    else
      bad "bash -n $ctm_s" "$(cat /tmp/.ctm_syn.$$ 2>/dev/null)"
    fi
    rm -f /tmp/.ctm_syn.$$ 2>/dev/null
  else
    # lib/resolve/load/publish are required; unshare is optional.
    if [ "$ctm_s" = "unshare.sh" ]; then
      ok "unshare.sh absent (optional) — skipped"
    else
      bad "missing required script $ctm_s"
    fi
  fi
done

# ===========================================================================
# 2) resolve: config hit => enabled, key acme/app, correct checkout + native.
#    resolve-repo.sh resolves based on CWD, so run it from inside the project.
# ===========================================================================
section "2. resolve: config hit => enabled with correct paths"
RJSON=$( cd "$PROJ" && bash "$SCRIPTS/resolve-repo.sh" 2>/dev/null )
assert_eq "enabled is true"            "true"               "$(json "$RJSON" '.enabled')"
assert_eq "projectKey is acme/app"     "$EXP_PROJECT_KEY"   "$(json "$RJSON" '.projectKey')"
assert_eq "storageUrl is the file:// remote" "$STORAGE_URL" "$(json "$RJSON" '.storageUrl')"
assert_eq "checkoutDir keyed by storage identity" "$EXP_CHECKOUT" "$(json "$RJSON" '.checkoutDir')"
assert_eq "targetMemoryDir = checkout/<org>/<repo>/memory" "$EXP_TARGET" "$(json "$RJSON" '.targetMemoryDir')"
assert_eq "nativeMemoryDir matches slug rule" "$NATIVE" "$(json "$RJSON" '.nativeMemoryDir')"
# Enabling implies the checkout was cloned (offline) on resolve.
assert_exists "checkout was cloned by resolve" "$EXP_CHECKOUT/.git"

# ===========================================================================
# 3) resolve: owner NOT in config => disabled.
#    A separate project whose origin owner ("globex") is absent from config.
# ===========================================================================
section "3. resolve: owner not in config => disabled"
PROJ_UNCFG="$T/proj/unconfigured"
mkdir -p "$PROJ_UNCFG"
git init -q -b main "$PROJ_UNCFG"
git -C "$PROJ_UNCFG" remote add origin "git@github.com:globex/app.git"
RJSON3=$( cd "$PROJ_UNCFG" && bash "$SCRIPTS/resolve-repo.sh" 2>/dev/null )
assert_eq "enabled is false (owner not configured)" "false" "$(json "$RJSON3" '.enabled')"
assert_contains "reason mentions the unconfigured owner" "$(json "$RJSON3" '.reason')" "globex"

# ===========================================================================
# 4) resolve: CLAUDE_TEAM_MEMORY_REPO override honored.
#    Point the override at the local bare repo from a project whose own config
#    owner would otherwise be a no-op (globex) — the override must win + clone.
# ===========================================================================
section "4. resolve: CLAUDE_TEAM_MEMORY_REPO override honored"
RJSON4=$( cd "$PROJ_UNCFG" && CLAUDE_TEAM_MEMORY_REPO="$STORAGE_URL" bash "$SCRIPTS/resolve-repo.sh" 2>/dev/null )
assert_eq "override => enabled"                 "true"          "$(json "$RJSON4" '.enabled')"
assert_eq "override => storageUrl is the override URL" "$STORAGE_URL" "$(json "$RJSON4" '.storageUrl')"
assert_contains "reason cites the env override" "$(json "$RJSON4" '.reason')" "CLAUDE_TEAM_MEMORY_REPO"
# Project key still derives from the PROJECT origin (globex/app), not the storage.
assert_eq "override keeps project key from origin" "globex/app" "$(json "$RJSON4" '.projectKey')"

# ===========================================================================
# 5) resolve: circular guard + "auto" string synthesis.
#   (a) storage URL == project origin => disabled (circular).
#   (b) "auto" resolves to <host>:<owner>/claude-team-memory — assert the STRING
#       only (no real GitHub clone).
# ===========================================================================
section "5a. resolve: circular guard (storage == origin) => disabled"
# A project whose ORIGIN *is* the storage repo itself.
PROJ_CIRC="$T/proj/circ"
mkdir -p "$PROJ_CIRC"
git init -q -b main "$PROJ_CIRC"
git -C "$PROJ_CIRC" remote add origin "$STORAGE_URL"
# Config maps that project's owner (parsed from the file:// URL => "acme") to the
# same storage URL, so resolution reaches the anti-circular guard.
RJSON5=$( cd "$PROJ_CIRC" && bash "$SCRIPTS/resolve-repo.sh" 2>/dev/null )
assert_eq "circular => enabled is false" "false" "$(json "$RJSON5" '.enabled')"
assert_contains "circular reason surfaced" "$(json "$RJSON5" '.reason')" "circular"

section "5b. resolve: \"auto\" => <host>:<owner>/claude-team-memory (string only)"
AUTO_URL=$(ctm_auto_storage_url "git@github.com:acme/app.git")
assert_eq "auto URL string for scp origin" "git@github.com:acme/claude-team-memory.git" "$AUTO_URL"
# And via the config-value normalizer (the path resolve-repo.sh uses for "auto").
AUTO_URL2=$(ctm_normalize_config_value "auto" "https://github.com/acme/app.git")
assert_eq "auto URL via normalizer (https origin)" "https://github.com/acme/claude-team-memory.git" "$AUTO_URL2"

# ===========================================================================
# 6) load: first run clones; teammate file -> SYMLINK in native dir; index has
#    its title; the seeded PERSONAL real file stays a REAL file (not symlinked,
#    not deleted).
#    load.sh runs resolve-repo.sh (cwd-based) internally, so run load from $PROJ.
# ===========================================================================
section "6. load: teammate file linked, personal real file preserved, index injected"
LJSON=$( cd "$PROJ" && bash "$SCRIPTS/load.sh" 2>/dev/null )
LCTX=$(json "$LJSON" '.hookSpecificOutput.additionalContext')

assert_symlink   "teammate-note.md is a symlink in native dir" "$NATIVE/teammate-note.md"
# The symlink resolves into the checkout (single physical copy lives there).
TN_TARGET=$(readlink "$NATIVE/teammate-note.md" 2>/dev/null)
assert_eq "teammate symlink points into the checkout target" "$EXP_TARGET/teammate-note.md" "$TN_TARGET"
assert_contains "injected index contains the teammate title" "$LCTX" "Teammate Deploy Note"

# Personal real file is untouched: still a real file, still present, NOT a symlink.
assert_real_file "personal my-prefs.md stays a real file" "$NATIVE/my-prefs.md"
assert_exists    "personal my-prefs.md still present"      "$NATIVE/my-prefs.md"
# Personal file must NOT be advertised in the team index (it was never shared).
assert_not_contains "personal title not in team index" "$LCTX" "My Editor Prefs"
# Preamble guard rails are present (team-shared / don't re-share).
assert_contains "preamble marks entries as team-shared" "$LCTX" "TEAM-SHARED"

# ===========================================================================
# 7) load: a dangling symlink pointing INTO the checkout is pruned; real files
#    are never pruned (even a dangling-looking real file is kept).
# ===========================================================================
section "7. load: prune dangling checkout symlink; never prune real files"
# Dangling symlink whose target is inside the checkout but does not exist.
ln -s "$EXP_TARGET/ghost.md" "$NATIVE/ghost.md"
# A dangling symlink pointing OUTSIDE the checkout must be left alone.
ln -s "$T/nowhere/outside.md" "$NATIVE/outside-link.md"
# A real file that happens to share no team name — must never be pruned.
printf 'local only\n' > "$NATIVE/keep-me.md"

LJSON7=$( cd "$PROJ" && bash "$SCRIPTS/load.sh" 2>/dev/null )
assert_absent  "dangling symlink into checkout was pruned" "$NATIVE/ghost.md"
assert_exists  "dangling symlink OUTSIDE checkout left intact" "$NATIVE/outside-link.md"
assert_real_file "unrelated local real file never pruned" "$NATIVE/keep-me.md"
# And the legitimate teammate symlink survives the prune pass.
assert_symlink "teammate symlink survives prune" "$NATIVE/teammate-note.md"
rm -f "$NATIVE/outside-link.md" "$NATIVE/keep-me.md" 2>/dev/null   # tidy for later steps

# ===========================================================================
# 8) load: a native REAL file with the SAME name as a team file is NOT
#    overwritten and is flagged as a conflict.
#    Push a team file named "api-shape.md" (the native dir already has a real
#    api-shape.md from seeding), then load and assert the clash is surfaced and
#    the local real file is untouched.
# ===========================================================================
section "8. load: real-vs-team name clash flagged, local real file preserved"
# Publish a teammate-authored api-shape.md into the remote (different bytes).
git -C "$SEED" pull -q --ff-only origin main >/dev/null 2>&1
cat > "$SEED/acme/app/memory/api-shape.md" <<'EOF'
---
name: API Shape (team)
description: canonical REST surface maintained by the team
metadata:
  type: project
  scope: team
  origin: team
---
GET /v1/things is cursor-paginated; POST /v1/things creates.
EOF
git -C "$SEED" add -A >/dev/null 2>&1
git -C "$SEED" commit -q -m "seed: team api-shape" >/dev/null 2>&1
git -C "$SEED" push -q origin main >/dev/null 2>&1
# Pull the new team file into the existing checkout so load sees it this run
# (load's own pull is backgrounded; pull synchronously here to make it
# deterministic for the test — we are testing reconcile, not the bg refresh).
git -C "$EXP_CHECKOUT" pull -q --ff-only origin main >/dev/null 2>&1

# Snapshot the local real file's bytes before load.
BEFORE=$(cat "$NATIVE/api-shape.md")
LJSON8=$( cd "$PROJ" && bash "$SCRIPTS/load.sh" 2>/dev/null )
LCTX8=$(json "$LJSON8" '.hookSpecificOutput.additionalContext')
AFTER=$(cat "$NATIVE/api-shape.md")

assert_real_file "clashing api-shape.md stays a REAL file (not symlinked)" "$NATIVE/api-shape.md"
assert_eq        "clashing api-shape.md bytes unchanged" "$BEFORE" "$AFTER"
assert_contains  "load surfaces the name clash" "$LCTX8" "api-shape.md"
assert_contains  "load explains it as a clash/conflict" "$LCTX8" "clash"

# ===========================================================================
# 9) publish mechanics: a team file written into the checkout + pushed appears
#    in the bare remote; byte-identical local => symlink; differing => real file.
#    (The skill's contract: it writes final bytes into the checkout target, THEN
#    calls publish.sh. We emulate the skill here with pre-prepared inputs.)
# ===========================================================================
section "9. publish: pushes to remote; identical->symlink, differ->real file"

# 9a. Identical case. Native real file == bytes we write into the checkout.
cat > "$NATIVE/runbook.md" <<'EOF'
---
name: Incident Runbook
description: first response steps for prod incidents
metadata:
  scope: team
---
Page the on-call, open a bridge, snapshot dashboards.
EOF
# Skill writes the SAME bytes into the checkout target.
cp "$NATIVE/runbook.md" "$EXP_TARGET/runbook.md"

# 9b. Differing case (simulating sanitization/merge by the skill): the native
# real file differs from what gets written to the checkout.
cat > "$NATIVE/contacts.md" <<'EOF'
---
name: Team Contacts
description: who to ping
metadata:
  scope: team
---
On-call phone: +1-555-0100 (secret-ish). Ping #oncall in chat.
EOF
cat > "$EXP_TARGET/contacts.md" <<'EOF'
---
name: Team Contacts
description: who to ping
metadata:
  scope: team
  origin: team
---
Ping #oncall in chat.
EOF

PJSON=$( cd "$PROJ" && bash "$SCRIPTS/publish.sh" \
  --checkout-dir "$EXP_CHECKOUT" \
  --target-dir   "$EXP_TARGET" \
  --native-dir   "$NATIVE" \
  --message      "test: publish runbook + contacts" \
  --slug runbook.md --slug contacts.md 2>/dev/null )

assert_eq "publish reports published=true" "true" "$(json "$PJSON" '.published')"
assert_eq "publish reports pushed=true"    "true" "$(json "$PJSON" '.pushed')"

# Both files now in the bare remote (verify via the remote's HEAD tree).
REMOTE_TREE=$(git -C "$REMOTE_DIR" ls-tree -r --name-only HEAD 2>/dev/null)
assert_contains "remote has runbook.md"  "$REMOTE_TREE" "acme/app/memory/runbook.md"
assert_contains "remote has contacts.md" "$REMOTE_TREE" "acme/app/memory/contacts.md"

# Identical => native real file converted to a symlink into the checkout.
assert_symlink "identical runbook.md became a symlink" "$NATIVE/runbook.md"
RB_TARGET=$(readlink "$NATIVE/runbook.md" 2>/dev/null)
assert_eq "runbook symlink points into the checkout" "$EXP_TARGET/runbook.md" "$RB_TARGET"
# per-slug JSON: linked=true for runbook.
RB_LINKED=$(json "$PJSON" '.slugs[] | select(.slug=="runbook.md") | .linked')
assert_eq "publish slugs[] marks runbook linked" "true" "$RB_LINKED"

# Differing => native real file KEPT (no data loss, DESIGN §7.8).
assert_real_file "differing contacts.md kept as a real file" "$NATIVE/contacts.md"
assert_contains "contacts.md still holds the local-only secret" "$(cat "$NATIVE/contacts.md")" "555-0100"
CT_KEPT=$(json "$PJSON" '.slugs[] | select(.slug=="contacts.md") | .keptLocal')
assert_eq "publish slugs[] marks contacts keptLocal" "true" "$CT_KEPT"

# ===========================================================================
# 10) publish idempotency: re-run does not create foo-2.md and skips
#     byte-identical files (no new commit, no churn).
# ===========================================================================
section "10. publish idempotency: no foo-2.md, byte-identical => no-op"
HEAD_BEFORE=$(git -C "$EXP_CHECKOUT" rev-parse HEAD 2>/dev/null)
# Re-stage the SAME bytes for runbook (already pushed + now a symlink locally).
# The checkout copy is unchanged, so publish must treat it as byte-identical.
PJSON10=$( cd "$PROJ" && bash "$SCRIPTS/publish.sh" \
  --checkout-dir "$EXP_CHECKOUT" \
  --target-dir   "$EXP_TARGET" \
  --native-dir   "$NATIVE" \
  --slug runbook.md 2>/dev/null )
HEAD_AFTER=$(git -C "$EXP_CHECKOUT" rev-parse HEAD 2>/dev/null)

assert_eq "re-publish still published=true" "true" "$(json "$PJSON10" '.published')"
assert_eq "re-publish made NO new commit (HEAD unchanged)" "$HEAD_BEFORE" "$HEAD_AFTER"
assert_eq "re-publish committed=false (byte-identical)" "false" "$(json "$PJSON10" '.committed')"
# No churn artifact: the upsert reuses the slug; never produces runbook-2.md.
assert_absent "no runbook-2.md created in checkout" "$EXP_TARGET/runbook-2.md"
assert_absent "no runbook-2.md created in native"   "$NATIVE/runbook-2.md"
# Exactly one runbook.md in the remote (the count must not grow).
RB_COUNT=$(git -C "$REMOTE_DIR" ls-tree -r --name-only HEAD 2>/dev/null | grep -c 'acme/app/memory/runbook\.md$')
assert_eq "remote still has exactly one runbook.md" "1" "$RB_COUNT"

# ===========================================================================
# 11) no-implicit-delete: removing a LOCAL file then running publish does NOT
#     remove it from the checkout/remote (DESIGN §7.4).
# ===========================================================================
section "11. no implicit delete: local removal does not delete shared copy"
# runbook.md currently exists locally as a symlink; remove the local entry.
rm -f "$NATIVE/runbook.md"
# Publish some OTHER slug (contacts.md again) — runbook is not even named, and
# even if it were, publish never deletes.
PJSON11=$( cd "$PROJ" && bash "$SCRIPTS/publish.sh" \
  --checkout-dir "$EXP_CHECKOUT" \
  --target-dir   "$EXP_TARGET" \
  --native-dir   "$NATIVE" \
  --slug contacts.md 2>/dev/null )
REMOTE_TREE11=$(git -C "$REMOTE_DIR" ls-tree -r --name-only HEAD 2>/dev/null)
assert_exists  "runbook.md still in the checkout after local removal" "$EXP_TARGET/runbook.md"
assert_contains "runbook.md still in the remote after local removal" "$REMOTE_TREE11" "acme/app/memory/runbook.md"

# ===========================================================================
# 12) unshare/tombstone: ONLY if scripts/unshare.sh exists. Exercise it; assert a
#     tombstone is written and the shared file removed. Otherwise log SKIP.
# ===========================================================================
section "12. unshare: tombstone written + shared file removed"
if [ -f "$SCRIPTS/unshare.sh" ]; then
  # Remove the previously-published runbook.md via the only deleter.
  bash "$SCRIPTS/unshare.sh" \
    --checkout "$EXP_CHECKOUT" \
    --target   "$EXP_TARGET" \
    --slug     runbook \
    --reason   "e2e test removal" \
    --by       "e2e-tester" >/dev/null 2>&1
  ctm_unshare_rc=$?
  assert_eq "unshare exits 0 (removed + pushed)" "0" "$ctm_unshare_rc"
  assert_absent "shared runbook.md removed from checkout" "$EXP_TARGET/runbook.md"
  assert_exists "tombstone written for runbook" "$EXP_TARGET/.tombstones/runbook.md"
  assert_contains "tombstone marks tombstone:true" "$(cat "$EXP_TARGET/.tombstones/runbook.md" 2>/dev/null)" "tombstone: true"
  # The removal + tombstone landed in the remote.
  REMOTE_TREE12=$(git -C "$REMOTE_DIR" ls-tree -r --name-only HEAD 2>/dev/null)
  assert_not_contains "remote no longer has runbook.md" "$REMOTE_TREE12" "acme/app/memory/runbook.md"
  assert_contains "remote has the tombstone" "$REMOTE_TREE12" "acme/app/memory/.tombstones/runbook.md"
else
  printf '  SKIP: scripts/unshare.sh not present — no scriptable unshare path.\n'
fi

# ===========================================================================
# Tally.
# ===========================================================================
TOTAL=$((PASS + FAIL))
printf '\n----------------------------------------\n'
printf 'PASSED: %s/%s\n' "$PASS" "$TOTAL"
if [ "$FAIL" -ne 0 ]; then
  printf 'FAILED: %s\n' "$FAIL"
  exit 1
fi
exit 0
