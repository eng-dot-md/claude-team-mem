#!/usr/bin/env node

// src/bin/cli.ts
import { execFileSync } from "node:child_process";
var REPO = "eng-dot-md/claude-team-mem";
var MARKETPLACE = "claude-team-mem";
var PLUGIN = "claude-team-mem";
var REF = `${PLUGIN}@${MARKETPLACE}`;
function exists(cmd) {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
function claude(args, opts = {}) {
  process.stderr.write(`
$ claude ${args.join(" ")}
`);
  try {
    execFileSync("claude", args, { stdio: "inherit" });
    return true;
  } catch (err) {
    if (opts.tolerate) {
      process.stderr.write(`  (continuing \u2014 step is non-fatal: ${err instanceof Error ? err.message : String(err)})
`);
      return false;
    }
    throw err;
  }
}
function requireClaude() {
  if (exists("claude")) return;
  console.error(
    `claude-team-mem: the \`claude\` CLI was not found on PATH.
Install Claude Code (https://claude.com/claude-code) first, or add the plugin
manually from inside a Claude Code session:
  /plugin marketplace add ${REPO}
  /plugin install ${REF}`
  );
  process.exit(1);
}
function install() {
  requireClaude();
  claude(["plugin", "marketplace", "add", REPO, "--scope", "user"], { tolerate: true });
  claude(["plugin", "install", REF, "--scope", "user"]);
  console.log(
    `
\u2713 Installed ${REF}.

One-time setup (the plugin no-ops until you map an owner \u2192 storage repo):
  \u2022 create a private team storage repo, e.g. <your-org>/claude-team-memory
  \u2022 in a project on that org, run:  /team-memory enable <your-org>
See the README / DESIGN.md \xA713 for details. Restart Claude Code to load the hook.`
  );
}
function uninstall() {
  requireClaude();
  claude(["plugin", "uninstall", REF], { tolerate: true });
  claude(["plugin", "marketplace", "remove", MARKETPLACE], { tolerate: true });
  console.log(
    `
\u2713 Removed ${REF} and its marketplace.
Your team storage repo and $CLAUDE_PLUGIN_DATA/config.json are left untouched.`
  );
}
function usage() {
  console.log(
    `claude-team-mem \u2014 share a team-relevant subset of Claude's memory across a team

Usage:
  npx claude-team-mem install     add the marketplace + install/enable the plugin (via the claude CLI)
  npx claude-team-mem uninstall   uninstall the plugin + remove the marketplace
  npx claude-team-mem help        show this help

This wraps the supported \`claude plugin\` commands. Equivalent manual flow:
  /plugin marketplace add ${REPO}
  /plugin install ${REF}`
  );
}
function main() {
  const cmd = (process.argv[2] ?? "help").toLowerCase();
  try {
    if (cmd === "install" || cmd === "i") install();
    else if (cmd === "uninstall" || cmd === "remove" || cmd === "rm") uninstall();
    else if (cmd === "help" || cmd === "--help" || cmd === "-h") usage();
    else {
      console.error(`claude-team-mem: unknown command "${cmd}"
`);
      usage();
      process.exit(2);
    }
  } catch (err) {
    console.error(`
claude-team-mem: command failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
main();
