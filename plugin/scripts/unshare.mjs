#!/usr/bin/env node

// src/bin/unshare.ts
import { writeFileSync as writeFileSync2 } from "node:fs";

// src/unshare.ts
import { existsSync as existsSync2, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join as join2, relative as relative2 } from "node:path";

// src/lib/git.ts
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// src/lib/log.ts
function ctmLog(msg) {
  try {
    process.stderr.write(`[claude-team-mem] ${msg}
`);
  } catch {
  }
}

// src/lib/git.ts
function git(args, opts = {}) {
  try {
    const stdout = execFileSync("git", args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      encoding: "utf8",
      timeout: opts.timeout ?? 12e4,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err;
    const toStr = (v) => v == null ? "" : typeof v === "string" ? v : v.toString("utf8");
    return {
      status: typeof e.status === "number" ? e.status : 1,
      stdout: toStr(e.stdout),
      stderr: toStr(e.stderr) || e.message || "git invocation failed"
    };
  }
}
function batchEnv(extra) {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -oBatchMode=yes -oStrictHostKeyChecking=accept-new",
    ...extra
  };
}
function ensureIdentity(checkout) {
  const haveName = git(["config", "--get", "user.name"], { cwd: checkout }).status === 0;
  const haveEmail = git(["config", "--get", "user.email"], { cwd: checkout }).status === 0;
  if (!haveName) git(["config", "user.name", "claude-team-mem"], { cwd: checkout });
  if (!haveEmail) git(["config", "user.email", "claude-team-mem@users.noreply.github.com"], { cwd: checkout });
}
function currentBranch(checkout) {
  const r = git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: checkout });
  if (r.status !== 0) return null;
  const b = r.stdout.trim();
  return b && b !== "HEAD" ? b : null;
}
function hasUpstream(checkout, branch) {
  return git(["rev-parse", "--abbrev-ref", `${branch}@{upstream}`], { cwd: checkout }).status === 0;
}
function pushWithRebase(checkout, opts = {}) {
  const branch = opts.branch ?? currentBranch(checkout);
  if (!branch) {
    return { ok: false, conflict: false, reason: "could not determine current branch" };
  }
  const retries = opts.retries && opts.retries > 0 ? opts.retries : 3;
  const env = batchEnv();
  let lastReason = "push not attempted";
  for (let attempt = 1; attempt <= retries; attempt++) {
    if (hasUpstream(checkout, branch)) {
      const pull = git(["pull", "--rebase", "origin", branch], { cwd: checkout, env });
      if (pull.status !== 0) {
        const conflict = rebaseInProgress(checkout);
        git(["rebase", "--abort"], { cwd: checkout, env });
        if (conflict) {
          return {
            ok: false,
            conflict: true,
            reason: `rebase conflict on attempt ${attempt}; aborted cleanly: ${pull.stderr.trim() || pull.stdout.trim()}`
          };
        }
        lastReason = pull.stderr.trim() || pull.stdout.trim() || "pull --rebase failed";
        ctmLog(`pull --rebase attempt ${attempt}/${retries} failed (no rebase in progress): ${lastReason}`);
        continue;
      }
    }
    const pushArgs = hasUpstream(checkout, branch) ? ["push", "origin", branch] : ["push", "-u", "origin", branch];
    const push = git(pushArgs, { cwd: checkout, env });
    if (push.status === 0) {
      return { ok: true, pushed: true, reason: `pushed ${branch} on attempt ${attempt}` };
    }
    lastReason = push.stderr.trim() || push.stdout.trim() || "push failed";
    ctmLog(`push attempt ${attempt}/${retries} failed: ${lastReason}`);
  }
  return { ok: false, conflict: false, reason: `push failed after ${retries} attempts: ${lastReason}` };
}
function rebaseInProgress(checkout) {
  for (const p of ["rebase-merge", "rebase-apply"]) {
    const r = git(["rev-parse", "--git-path", p], { cwd: checkout });
    if (r.status === 0 && existsSync(resolve(checkout, r.stdout.trim()))) return true;
  }
  return false;
}
function hasUnpushedCommits(checkout) {
  const branch = currentBranch(checkout);
  if (!branch) return false;
  let base = null;
  if (hasUpstream(checkout, branch)) {
    base = `${branch}@{upstream}`;
  } else if (git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], { cwd: checkout }).status === 0) {
    base = `origin/${branch}`;
  }
  if (!base) {
    return git(["rev-list", "-n", "1", "HEAD"], { cwd: checkout }).status === 0;
  }
  const ahead = git(["rev-list", "--count", `${base}..HEAD`], { cwd: checkout });
  const n = ahead.status === 0 ? ahead.stdout.trim() : "0";
  return n !== "" && n !== "0";
}

// src/lib/frontmatter.ts
import { readFileSync } from "node:fs";
import { basename } from "node:path";
function unquote(v) {
  const s = v.trim();
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if (first === '"' && last === '"' || first === "'" && last === "'") {
      return s.slice(1, -1);
    }
  }
  return s;
}
function indentOf(line) {
  let n = 0;
  while (n < line.length && (line[n] === " " || line[n] === "	")) n++;
  return n;
}
function parseFrontmatter(content) {
  const text = content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  if (lines.length === 0 || lines[0] !== "---") {
    return { data: {}, body: content };
  }
  let close = -1;
  for (let i2 = 1; i2 < lines.length; i2++) {
    if (lines[i2] === "---") {
      close = i2;
      break;
    }
  }
  if (close === -1) {
    return { data: {}, body: content };
  }
  const fmLines = lines.slice(1, close);
  const body = lines.slice(close + 1).join("\n");
  const data = {};
  let i = 0;
  while (i < fmLines.length) {
    const line = fmLines[i] ?? "";
    i++;
    if (line.trim().length === 0) continue;
    if (indentOf(line) > 0) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const rest = line.slice(colon + 1);
    if (key.length === 0) continue;
    if (rest.trim().length === 0) {
      const block = {};
      let sawChild = false;
      while (i < fmLines.length) {
        const child = fmLines[i] ?? "";
        if (child.trim().length === 0) {
          i++;
          continue;
        }
        if (indentOf(child) === 0) break;
        i++;
        const c = child.indexOf(":");
        if (c < 0) continue;
        const ck = child.slice(0, c).trim();
        const cv = unquote(child.slice(c + 1));
        if (ck.length > 0) {
          block[ck] = cv;
          sawChild = true;
        }
      }
      data[key] = sawChild ? block : {};
    } else {
      data[key] = unquote(rest);
    }
  }
  return { data, body };
}
function metadataRecord(value) {
  const out = {};
  if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === "string") out[k] = v;
      else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
    }
  }
  return out;
}
function readMemory(file) {
  const slug = basename(file);
  try {
    const content = readFileSync(file, "utf8");
    const { data, body } = parseFrontmatter(content);
    const name = typeof data.name === "string" ? data.name : void 0;
    const description = typeof data.description === "string" ? data.description : void 0;
    return {
      slug,
      ...name !== void 0 ? { name } : {},
      ...description !== void 0 ? { description } : {},
      metadata: metadataRecord(data.metadata),
      body
    };
  } catch (err) {
    ctmLog(`readMemory failed for ${file}: ${String(err)}`);
    return { slug, metadata: {} };
  }
}
function isValidSlug(slug) {
  if (!slug) return false;
  const s = slug;
  if (s.length === 0) return false;
  if (s === "." || s === "..") return false;
  if (s.startsWith("/")) return false;
  if (s.includes("/") || s.includes("\\")) return false;
  if (s.includes("\0")) return false;
  if (s.split(/[/\\]/).some((seg) => seg === "..")) return false;
  return true;
}

// src/lib/paths.ts
import { join, resolve as resolve2, relative, isAbsolute } from "node:path";
function pathInside(child, parent) {
  try {
    const c = resolve2(child);
    const p = resolve2(parent);
    if (c === p) return true;
    const rel = relative(p, c);
    return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
  } catch {
    return false;
  }
}

// src/unshare.ts
function toFileName(slug) {
  const s = slug.trim();
  return s.endsWith(".md") ? s : `${s}.md`;
}
function nowIso() {
  try {
    return (/* @__PURE__ */ new Date()).toISOString();
  } catch {
    return void 0;
  }
}
function tombstoneContent(base, title, reason, by, lastAuthor, at) {
  const fm = ["---", "tombstone: true", `slug: ${base}`, `title: ${title}`];
  if (at) fm.push(`removedAt: ${at}`);
  fm.push(`removedBy: ${by}`, `lastAuthor: ${lastAuthor}`, "---");
  const body = [
    `This shared memory was unshared via \`/team-memory unshare ${base}\`.`,
    "",
    `Reason: ${reason}`,
    "",
    "The fact is no longer team memory. Do not re-publish it without checking",
    "with the team first. Publish refuses any slug that has a tombstone here;",
    "delete this tombstone only if the fact is later legitimately re-shared.",
    ""
  ];
  return `${fm.join("\n")}
${body.join("\n")}`;
}
function fail(reason, extra) {
  return {
    removed: false,
    pushed: false,
    conflict: false,
    tombstone: null,
    reason,
    notFound: false,
    ...extra
  };
}
function unshare(opts) {
  try {
    const { checkoutDir, targetMemoryDir } = opts;
    if (!checkoutDir || !targetMemoryDir || !opts.slug) {
      return fail("checkoutDir, targetMemoryDir and slug are all required");
    }
    const fileName = toFileName(opts.slug);
    if (!isValidSlug(fileName)) {
      return fail(`refusing unsafe slug "${opts.slug}" (must be a bare file name)`);
    }
    const base = fileName.endsWith(".md") ? fileName.slice(0, -3) : fileName;
    if (!existsSync2(join2(checkoutDir, ".git"))) {
      return fail(`"${checkoutDir}" is not a git checkout`);
    }
    if (!pathInside(targetMemoryDir, checkoutDir)) {
      return fail("target dir is not inside the checkout (refusing)");
    }
    const file = join2(targetMemoryDir, fileName);
    if (!existsSync2(file)) {
      const relPath = relative2(checkoutDir, file);
      const inHead = git(["cat-file", "-e", `HEAD:${relPath}`], { cwd: checkoutDir }).status === 0;
      if (!inHead && hasUnpushedCommits(checkoutDir)) {
        const tomb = join2(targetMemoryDir, ".tombstones", fileName);
        const tombstone = existsSync2(tomb) ? tomb : null;
        const push2 = pushWithRebase(checkoutDir);
        if (push2.ok) {
          return {
            removed: true,
            pushed: true,
            conflict: false,
            tombstone,
            reason: `removal of ${base} was committed earlier; flushed the pending push to the remote`,
            notFound: false
          };
        }
        return {
          removed: true,
          pushed: false,
          conflict: push2.conflict,
          tombstone,
          reason: push2.conflict ? `removal of ${base} is committed locally but a rebase conflict blocks the push; Claude must merge then re-run` : `removal of ${base} is committed locally but still unpushed; re-run to retry: ${push2.reason}`,
          notFound: false
        };
      }
      return fail(`no shared file "${fileName}" in ${targetMemoryDir} (nothing to remove)`, {
        notFound: true
      });
    }
    const tracked = git(["ls-files", "--error-unmatch", "--", file], { cwd: checkoutDir });
    if (tracked.status !== 0) {
      return fail(`"${fileName}" exists in the checkout but is not tracked/shared upstream (nothing to unshare)`, {
        notFound: true
      });
    }
    const lastAuthorRes = git(["log", "-1", "--format=%an <%ae>", "--", file], { cwd: checkoutDir });
    const lastAuthor = lastAuthorRes.status === 0 && lastAuthorRes.stdout.trim().length > 0 ? lastAuthorRes.stdout.trim() : "unknown";
    let by = (opts.by ?? "").trim();
    if (by.length === 0) {
      const cfgName = git(["config", "user.name"], { cwd: checkoutDir });
      by = cfgName.status === 0 ? cfgName.stdout.trim() : "";
    }
    if (by.length === 0) by = "unknown";
    const reason = (opts.reason ?? "").trim() || "(no reason given)";
    const at = opts.at && opts.at.trim().length > 0 ? opts.at.trim() : nowIso();
    const mem = readMemory(file);
    const title = mem.name && mem.name.length > 0 ? mem.name : base;
    const tdir = join2(targetMemoryDir, ".tombstones");
    const tfile = join2(tdir, fileName);
    try {
      mkdirSync(tdir, { recursive: true });
      writeFileSync(tfile, tombstoneContent(base, title, reason, by, lastAuthor, at), "utf8");
    } catch (err) {
      return fail(`could not write tombstone ${tfile}: ${String(err)}`);
    }
    const rm = git(["rm", "-q", "-f", "--", file], { cwd: checkoutDir });
    if (rm.status !== 0) {
      try {
        rmSync(file, { force: true });
      } catch {
      }
      git(["add", "-A", "--", file], { cwd: checkoutDir });
      const stillTracked = git(["ls-files", "--error-unmatch", "--", file], { cwd: checkoutDir });
      if (stillTracked.status === 0) {
        return fail(`could not stage removal of ${fileName}; aborting (nothing committed)`, {
          tombstone: tfile
        });
      }
    }
    git(["add", "--", tfile], { cwd: checkoutDir });
    ensureIdentity(checkoutDir);
    const msg = `chore(memory): unshare ${base}

Remove shared memory '${title}' and record a tombstone.
Reason: ${reason}
Removed-by: ${by}`;
    const commit = git(["commit", "-q", "-m", msg, "--", file, tfile], { cwd: checkoutDir });
    if (commit.status !== 0) {
      return fail(`nothing committed (no staged changes?): ${commit.stderr.trim() || commit.stdout.trim()}`, {
        tombstone: tfile
      });
    }
    ctmLog(`unshare: committed removal of ${base} + tombstone`);
    const push = pushWithRebase(checkoutDir);
    if (push.ok) {
      return {
        removed: true,
        pushed: true,
        conflict: false,
        tombstone: tfile,
        reason: `unshared ${base}; ${push.reason}`,
        notFound: false
      };
    }
    return {
      removed: true,
      pushed: false,
      conflict: push.conflict,
      tombstone: tfile,
      reason: push.conflict ? `removal committed locally but a rebase conflict blocked the push: ${push.reason}` : `removal committed locally but the push failed: ${push.reason}`,
      notFound: false
    };
  } catch (err) {
    return fail(`unshare failed: ${String(err)}`);
  }
}

// src/bin/unshare.ts
var VALUE_FLAGS = /* @__PURE__ */ new Set([
  "checkout-dir",
  "target-dir",
  "slug",
  "reason",
  "by",
  "at"
]);
function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === void 0) continue;
    if (!tok.startsWith("--")) {
      return { values, error: `unexpected argument "${tok}"` };
    }
    const body = tok.slice(2);
    const eq = body.indexOf("=");
    const name = eq >= 0 ? body.slice(0, eq) : body;
    if (!VALUE_FLAGS.has(name)) {
      return { values, error: `unknown flag "--${name}"` };
    }
    const flag = name;
    if (eq >= 0) {
      values[flag] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next === void 0 || next.startsWith("--")) {
      return { values, error: `flag "--${name}" expects a value` };
    }
    values[flag] = next;
    i++;
  }
  return { values };
}
function exitCodeFor(r) {
  if (r.notFound) return 3;
  if (r.removed && r.pushed) return 0;
  if (r.removed && r.conflict) return 4;
  if (r.removed) return 5;
  return 2;
}
function printResult(result) {
  writeFileSync2(1, JSON.stringify(result) + "\n");
}
function main() {
  const { values, error } = parseArgs(process.argv.slice(2));
  if (error) {
    ctmLog(`unshare: ${error}`);
    printResult({
      removed: false,
      pushed: false,
      conflict: false,
      tombstone: null,
      reason: error,
      notFound: false
    });
    process.exit(2);
  }
  const checkoutDir = values["checkout-dir"] ?? "";
  const targetMemoryDir = values["target-dir"] ?? "";
  const slug = values["slug"] ?? "";
  if (!checkoutDir || !targetMemoryDir || !slug) {
    const reason = "usage: --checkout-dir <dir> --target-dir <dir> --slug <slug> [--reason <text>] [--by <author>]";
    ctmLog(`unshare: missing required flags. ${reason}`);
    printResult({
      removed: false,
      pushed: false,
      conflict: false,
      tombstone: null,
      reason,
      notFound: false
    });
    process.exit(2);
  }
  const result = unshare({
    checkoutDir,
    targetMemoryDir,
    slug,
    ...values.reason !== void 0 ? { reason: values.reason } : {},
    ...values.by !== void 0 ? { by: values.by } : {},
    ...values.at !== void 0 ? { at: values.at } : {}
  });
  printResult(result);
  process.exit(exitCodeFor(result));
}
main();
