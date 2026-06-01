#!/usr/bin/env node

// src/bin/publish.ts
import { writeFileSync } from "node:fs";

// src/publish.ts
import {
  existsSync as existsSync2,
  lstatSync,
  mkdirSync,
  readFileSync as readFileSync2,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync
} from "node:fs";
import { dirname, join as join2, resolve as resolve3 } from "node:path";

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

// src/publish.ts
function sameBytes(a, b) {
  try {
    if (!existsSync2(a) || !existsSync2(b)) return false;
    const ba = readFileSync2(a);
    const bb = readFileSync2(b);
    return ba.length === bb.length && ba.equals(bb);
  } catch {
    return false;
  }
}
function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
function lexists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
function resolveSymlink(linkPath) {
  try {
    const target = readlinkSync(linkPath);
    return resolve3(dirname(resolve3(linkPath)), target);
  } catch {
    return null;
  }
}
function stageExact(checkoutDir, targetPath) {
  return git(["add", "--", targetPath], { cwd: checkoutDir });
}
function keptLocalResult(acc, note) {
  return {
    slug: acc.slug,
    accepted: true,
    inCheckout: existsSync2(acc.targetPath),
    linked: false,
    keptLocal: true,
    note
  };
}
function linkBackPushed(accepted, nativeMemoryDir) {
  const results = [];
  for (const acc of accepted) {
    const src = acc.targetPath;
    if (!existsSync2(src)) {
      results.push({
        slug: acc.slug,
        accepted: true,
        inCheckout: false,
        linked: false,
        keptLocal: true,
        note: "checkout copy missing after push; local kept"
      });
      continue;
    }
    if (!nativeMemoryDir) {
      results.push({
        slug: acc.slug,
        accepted: true,
        inCheckout: true,
        linked: false,
        keptLocal: false,
        note: "no native dir; checkout updated, nothing linked"
      });
      continue;
    }
    const dst = join2(nativeMemoryDir, acc.slug);
    const absSrc = resolve3(src);
    if (isSymlink(dst)) {
      const real = resolveSymlink(dst);
      if (real === absSrc) {
        results.push({
          slug: acc.slug,
          accepted: true,
          inCheckout: true,
          linked: true,
          keptLocal: false,
          note: "native already a symlink into the checkout (already team)"
        });
        continue;
      }
      results.push({
        slug: acc.slug,
        accepted: true,
        inCheckout: true,
        linked: false,
        keptLocal: true,
        note: "native is an unrelated symlink (not into this checkout); left as-is"
      });
      continue;
    }
    if (!lexists(dst)) {
      try {
        mkdirSync(nativeMemoryDir, { recursive: true });
        symlinkSync(absSrc, dst);
        results.push({
          slug: acc.slug,
          accepted: true,
          inCheckout: true,
          linked: true,
          keptLocal: false,
          note: "created absolute symlink into the checkout (no prior native file)"
        });
      } catch (err) {
        results.push({
          slug: acc.slug,
          accepted: true,
          inCheckout: true,
          linked: false,
          keptLocal: false,
          note: `could not create symlink (${String(err)}); checkout has the copy`
        });
      }
      continue;
    }
    if (sameBytes(dst, src)) {
      const tmp = `${dst}.ctmlink.${process.pid}`;
      try {
        rmSync(tmp, { force: true });
        symlinkSync(absSrc, tmp);
        renameSync(tmp, dst);
        results.push({
          slug: acc.slug,
          accepted: true,
          inCheckout: true,
          linked: true,
          keptLocal: false,
          note: "identical to pushed copy; converted local real file to absolute symlink"
        });
      } catch (err) {
        try {
          rmSync(tmp, { force: true });
        } catch {
        }
        results.push({
          slug: acc.slug,
          accepted: true,
          inCheckout: true,
          linked: false,
          keptLocal: true,
          note: `identical but symlink conversion failed (${String(err)}); local real file kept`
        });
      }
      continue;
    }
    results.push({
      slug: acc.slug,
      accepted: true,
      inCheckout: true,
      linked: false,
      keptLocal: true,
      note: "differs from pushed copy (sanitized/merged); local real file kept (offer to split into a personal memory)"
    });
  }
  return results;
}
function publish(opts) {
  const { checkoutDir, targetMemoryDir } = opts;
  const nativeDir = opts.nativeMemoryDir && opts.nativeMemoryDir.length > 0 ? opts.nativeMemoryDir : void 0;
  const message = opts.message && opts.message.length > 0 ? opts.message : "team-memory: publish shared memory";
  if (!checkoutDir || !existsSync2(join2(checkoutDir, ".git"))) {
    return {
      published: false,
      pushed: false,
      committed: false,
      reason: `checkout dir missing or not a git repo: ${checkoutDir}`,
      commit: "",
      slugs: []
    };
  }
  if (!targetMemoryDir) {
    return {
      published: false,
      pushed: false,
      committed: false,
      reason: "no targetMemoryDir provided",
      commit: "",
      slugs: []
    };
  }
  if (!pathInside(targetMemoryDir, checkoutDir)) {
    return {
      published: false,
      pushed: false,
      committed: false,
      reason: `target dir is not inside the checkout (refusing): ${targetMemoryDir}`,
      commit: "",
      slugs: []
    };
  }
  const tombstoneDir = join2(targetMemoryDir, ".tombstones");
  const perSlug = [];
  const accepted = [];
  for (const rawSlug of opts.slugs) {
    const trimmed = (rawSlug ?? "").trim();
    const slug = trimmed.length > 0 && !trimmed.endsWith(".md") ? `${trimmed}.md` : trimmed;
    if (!isValidSlug(slug)) {
      perSlug.push({
        slug: rawSlug ?? "",
        accepted: false,
        inCheckout: false,
        linked: false,
        keptLocal: false,
        note: "invalid slug (separator, leading slash, or `..` component); skipped"
      });
      continue;
    }
    const targetPath = join2(targetMemoryDir, slug);
    if (existsSync2(join2(tombstoneDir, slug))) {
      perSlug.push({
        slug,
        accepted: false,
        inCheckout: existsSync2(targetPath),
        linked: false,
        keptLocal: false,
        note: "a tombstone exists for this slug (previously unshared); refusing to re-publish. Use /team-memory to manage tombstones."
      });
      continue;
    }
    if (existsSync2(targetPath)) {
      const mem = readMemory(targetPath);
      if (mem.metadata.origin === "team") {
        perSlug.push({
          slug,
          accepted: false,
          inCheckout: true,
          linked: false,
          keptLocal: false,
          note: "frontmatter metadata.origin == team (team-provenance); skipped (not re-published)"
        });
        continue;
      }
    }
    accepted.push({ slug, targetPath });
  }
  if (accepted.length === 0) {
    return {
      published: true,
      pushed: false,
      committed: false,
      reason: perSlug.length > 0 ? "no publishable slugs (all invalid / tombstoned / team-origin)" : "no slugs to publish (no-op)",
      commit: "",
      slugs: perSlug
    };
  }
  ensureIdentity(checkoutDir);
  const stagedPathspecs = [];
  for (const acc of accepted) {
    if (!existsSync2(acc.targetPath)) {
      continue;
    }
    stageExact(checkoutDir, acc.targetPath);
    stagedPathspecs.push(acc.targetPath);
  }
  const stagedDiffers = stagedPathspecs.length > 0 && git(["diff", "--cached", "--quiet", "--", ...stagedPathspecs], { cwd: checkoutDir }).status !== 0;
  const committedSha = () => {
    const r = git(["rev-parse", "HEAD"], { cwd: checkoutDir });
    return r.status === 0 ? r.stdout.trim() : "";
  };
  const pushOpts = opts.retries && opts.retries > 0 ? { retries: opts.retries } : {};
  if (!stagedDiffers) {
    if (hasUnpushedCommits(checkoutDir)) {
      const outcome2 = pushWithRebase(checkoutDir, pushOpts);
      if (!outcome2.ok) {
        const kept = accepted.map(
          (a) => keptLocalResult(
            a,
            outcome2.conflict ? "a prior commit is unpushed and a rebase conflict blocks it; Claude must merge then re-run" : "a prior commit is unpushed and the push failed; re-run to retry (nothing lost)"
          )
        );
        return {
          published: false,
          pushed: false,
          committed: false,
          reason: `local commit(s) not yet on the remote; push pending: ${outcome2.reason}`,
          commit: committedSha(),
          slugs: [...perSlug, ...kept]
        };
      }
      const linked3 = linkBackPushed(accepted, nativeDir);
      return {
        published: true,
        pushed: true,
        committed: false,
        reason: "no new changes; flushed a pending local commit to the remote",
        commit: committedSha(),
        slugs: [...perSlug, ...linked3]
      };
    }
    const linked2 = linkBackPushed(accepted, nativeDir);
    if (stagedPathspecs.length === 0) {
      return {
        published: false,
        pushed: false,
        committed: false,
        reason: "none of the named slugs were present in the checkout target; nothing published",
        commit: committedSha(),
        slugs: [...perSlug, ...linked2]
      };
    }
    return {
      published: true,
      pushed: false,
      committed: false,
      reason: "all named slugs byte-identical and already on the remote (no-op)",
      commit: committedSha(),
      slugs: [...perSlug, ...linked2]
    };
  }
  const commit = git(["commit", "-m", message, "--", ...stagedPathspecs], { cwd: checkoutDir });
  if (commit.status !== 0) {
    const kept = accepted.map((a) => keptLocalResult(a, "commit failed; local real file kept"));
    return {
      published: false,
      pushed: false,
      committed: false,
      reason: `git commit failed; local real files kept: ${commit.stderr.trim() || commit.stdout.trim()}`,
      commit: "",
      slugs: [...perSlug, ...kept]
    };
  }
  const outcome = pushWithRebase(checkoutDir, pushOpts);
  if (!outcome.ok) {
    const sha2 = committedSha();
    const kept = accepted.map(
      (a) => keptLocalResult(
        a,
        outcome.conflict ? "rebase conflict; local real file kept (commit is local-only; Claude must merge both sides then re-run)" : "push failed; local real file kept (commit is local-only; re-run to retry)"
      )
    );
    return {
      published: false,
      pushed: false,
      committed: true,
      reason: outcome.conflict ? `a teammate change conflicts with this commit; ${outcome.reason}. Claude must merge both sides (DESIGN \xA79) then re-run /share-memory. Local files kept; commit ${sha2} is local-only.` : `committed locally but ${outcome.reason}; local real files kept; commit ${sha2} is local-only (re-run /share-memory to retry; never force-push)`,
      commit: sha2,
      slugs: [...perSlug, ...kept]
    };
  }
  const sha = committedSha();
  const linked = linkBackPushed(accepted, nativeDir);
  ctmLog(`publish: ${outcome.reason}`);
  return {
    published: true,
    pushed: true,
    committed: true,
    reason: `${outcome.reason}; commit ${sha}`,
    commit: sha,
    slugs: [...perSlug, ...linked]
  };
}

// src/bin/publish.ts
function emit(result) {
  writeFileSync(1, JSON.stringify(result) + "\n");
  process.exit(0);
}
function fail(msg) {
  ctmLog(`publish: ${msg}`);
  process.exit(2);
}
function parseArgs(argv) {
  const out = { slugs: [] };
  let i = 0;
  const takeValue = (flag) => {
    const v = argv[i + 1];
    if (v === void 0) fail(`missing value for ${flag}`);
    if (v.startsWith("--")) fail(`missing value for ${flag} (got flag ${v})`);
    i += 2;
    return v;
  };
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === void 0) break;
    switch (arg) {
      case "--checkout-dir":
        out.checkoutDir = takeValue(arg);
        break;
      case "--target-dir":
        out.targetDir = takeValue(arg);
        break;
      case "--native-dir":
        out.nativeDir = takeValue(arg);
        break;
      case "--message":
        out.message = takeValue(arg);
        break;
      case "--retries": {
        const raw = takeValue(arg);
        const n = Number(raw);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
          fail(`--retries must be a positive integer (got ${raw})`);
        }
        out.retries = n;
        break;
      }
      case "--slug":
        out.slugs.push(takeValue(arg));
        break;
      default:
        fail(`unknown argument: ${arg}`);
    }
  }
  return out;
}
function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.checkoutDir) fail("missing required --checkout-dir");
  if (!parsed.targetDir) fail("missing required --target-dir");
  const opts = {
    checkoutDir: parsed.checkoutDir,
    targetMemoryDir: parsed.targetDir,
    slugs: parsed.slugs,
    ...parsed.nativeDir !== void 0 ? { nativeMemoryDir: parsed.nativeDir } : {},
    ...parsed.message !== void 0 ? { message: parsed.message } : {},
    ...parsed.retries !== void 0 ? { retries: parsed.retries } : {}
  };
  try {
    emit(publish(opts));
  } catch (err) {
    emit({
      published: false,
      pushed: false,
      committed: false,
      reason: `unexpected error: ${String(err)}`,
      commit: "",
      slugs: []
    });
  }
}
main();
