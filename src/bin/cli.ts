// `npx claude-team-mem <install|uninstall|help>` — a thin installer that wraps the
// SUPPORTED `claude plugin` CLI (no reverse-engineering of Claude Code's internal
// plugin state). `install` registers this repo as a marketplace and installs +
// enables the plugin; `uninstall` reverses it. Everything it does is equivalent to
// the manual `/plugin marketplace add` + `/plugin install` flow.

import { execFileSync } from 'node:child_process'

const REPO = 'eng-dot-md/claude-team-mem' // GitHub source for `marketplace add`
const MARKETPLACE = 'claude-team-mem' // marketplace.json "name"
const PLUGIN = 'claude-team-mem' // plugin manifest "name"
const REF = `${PLUGIN}@${MARKETPLACE}` // plugin@marketplace selector

/** True if `cmd --version` runs (i.e. the command exists on PATH). */
function exists(cmd: string): boolean {
  try {
    execFileSync(cmd, ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** Run `claude <args...>` inheriting stdio so the user sees its output. */
function claude(args: string[], opts: { tolerate?: boolean } = {}): boolean {
  process.stderr.write(`\n$ claude ${args.join(' ')}\n`)
  try {
    execFileSync('claude', args, { stdio: 'inherit' })
    return true
  } catch (err) {
    if (opts.tolerate) {
      process.stderr.write(`  (continuing — step is non-fatal: ${err instanceof Error ? err.message : String(err)})\n`)
      return false
    }
    throw err
  }
}

function requireClaude(): void {
  if (exists('claude')) return
  console.error(
    'claude-team-mem: the `claude` CLI was not found on PATH.\n' +
      'Install Claude Code (https://claude.com/claude-code) first, or add the plugin\n' +
      'manually from inside a Claude Code session:\n' +
      `  /plugin marketplace add ${REPO}\n` +
      `  /plugin install ${REF}`,
  )
  process.exit(1)
}

function install(): void {
  requireClaude()
  // 1. Register this repo as a user marketplace (tolerate "already added" on re-run).
  claude(['plugin', 'marketplace', 'add', REPO, '--scope', 'user'], { tolerate: true })
  // 2. Install + enable the plugin from that marketplace.
  claude(['plugin', 'install', REF, '--scope', 'user'])
  console.log(
    `\n✓ Installed ${REF}.\n\n` +
      'One-time setup (the plugin no-ops until you map an owner → storage repo):\n' +
      '  • create a private team storage repo, e.g. <your-org>/claude-team-memory\n' +
      '  • in a project on that org, run:  /team-memory enable <your-org>\n' +
      'See the README / DESIGN.md §13 for details. Restart Claude Code to load the hook.',
  )
}

function uninstall(): void {
  requireClaude()
  claude(['plugin', 'uninstall', REF], { tolerate: true })
  claude(['plugin', 'marketplace', 'remove', MARKETPLACE], { tolerate: true })
  console.log(
    `\n✓ Removed ${REF} and its marketplace.\n` +
      'Your team storage repo and $CLAUDE_PLUGIN_DATA/config.json are left untouched.',
  )
}

function usage(): void {
  console.log(
    `claude-team-mem — share a team-relevant subset of Claude's memory across a team\n\n` +
      'Usage:\n' +
      '  npx claude-team-mem install     add the marketplace + install/enable the plugin (via the claude CLI)\n' +
      '  npx claude-team-mem uninstall   uninstall the plugin + remove the marketplace\n' +
      '  npx claude-team-mem help        show this help\n\n' +
      'This wraps the supported `claude plugin` commands. Equivalent manual flow:\n' +
      `  /plugin marketplace add ${REPO}\n` +
      `  /plugin install ${REF}`,
  )
}

function main(): void {
  const cmd = (process.argv[2] ?? 'help').toLowerCase()
  try {
    if (cmd === 'install' || cmd === 'i') install()
    else if (cmd === 'uninstall' || cmd === 'remove' || cmd === 'rm') uninstall()
    else if (cmd === 'help' || cmd === '--help' || cmd === '-h') usage()
    else {
      console.error(`claude-team-mem: unknown command "${cmd}"\n`)
      usage()
      process.exit(2)
    }
  } catch (err) {
    console.error(`\nclaude-team-mem: command failed: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

main()
