// Shared, strongly-typed interfaces for the claude-team-mem plugin.
// Every other module imports from here. Keep this file dependency-free.

/**
 * The result of resolving "which storage repo (if any) backs this project".
 * When `enabled` is false the plugin no-ops; the optional path fields are then
 * absent. `reason` is always set (human-readable, for `ctmLog`/status output).
 */
export interface Resolution {
  /** True only when a storage repo is configured AND the anti-circular guard passed. */
  enabled: boolean
  /** Human-readable explanation (e.g. "owner acme -> auto", "disabled: no config match"). */
  reason: string
  /** Resolved storage repo git URL (normalized form used for the checkout). */
  storageUrl?: string
  /** Absolute path to the local checkout of the storage repo. */
  checkoutDir?: string
  /** Subtree key inside the storage repo: `<org>/<repo>`. */
  projectKey?: string
  /** Absolute path to `<checkoutDir>/<projectKey>/memory` (where shared bytes live). */
  targetMemoryDir?: string
  /** Absolute path to Claude's native per-project memory dir, when derivable. */
  nativeMemoryDir?: string
}

/** A git remote URL parsed into its identity components. */
export interface ParsedRemote {
  /** Host, e.g. `github.com`, `gitlab.example.com`. */
  host: string
  /** Owner / org / nested group path, e.g. `acme` or `group/sub`. */
  owner: string
  /** Repository name (no trailing `.git`). */
  repo: string
}

/**
 * A single memory file: its on-disk slug (filename incl. extension) plus the
 * parsed frontmatter fields the plugin cares about, and the markdown body.
 */
export interface Memory {
  /** Filename including extension, e.g. `foo.md` — the upsert key. */
  slug: string
  /** Frontmatter `name`, if present. */
  name?: string
  /** Frontmatter `description`, if present. */
  description?: string
  /** Parsed `metadata:` block (scope, origin, type, ...). String values only. */
  metadata: Record<string, string>
  /** Markdown body (everything after the frontmatter block). */
  body?: string
}

/**
 * Plugin config, stored at `<dataDir>/config.json`.
 * `owners` maps a GitHub owner -> storage spec ("auto" | "owner/repo" | full URL).
 */
export interface Config {
  /** owner -> "auto" | "owner/repo" | full git URL. */
  owners: Record<string, string>
  /** Max bytes of derived index injected at SessionStart (default 20000; 0 = uncapped). */
  maxIndexBytes?: number
}
