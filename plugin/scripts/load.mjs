#!/usr/bin/env node

// src/bin/load.ts
import { readFileSync as readFileSync3, writeFileSync as writeFileSync2 } from "node:fs";

// src/load.ts
import { spawn } from "node:child_process";
import {
  existsSync as existsSync4,
  lstatSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync
} from "node:fs";
import { isAbsolute as isAbsolute2, join as join4, resolve as resolvePath } from "node:path";

// src/lib/git.ts
import { execFileSync } from "node:child_process";

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
function cloneOnce(url, dir) {
  const inside = git(["rev-parse", "--is-inside-work-tree"], { cwd: dir, env: batchEnv() });
  if (inside.status === 0 && inside.stdout.trim() === "true") {
    return { status: 0, stdout: "already cloned", stderr: "" };
  }
  const res = git(["clone", url, dir], { env: batchEnv(), timeout: 3e5 });
  if (res.status !== 0) ctmLog(`clone failed for ${url}: ${res.stderr.trim()}`);
  return res;
}

// src/lib/remote.ts
function stripTail(s) {
  let out = s;
  while (out.endsWith("/")) out = out.slice(0, -1);
  if (out.endsWith(".git")) out = out.slice(0, -4);
  while (out.endsWith("/")) out = out.slice(0, -1);
  return out;
}
function fromHostPath(host, path) {
  const cleanHost = host.trim();
  const segments = path.split("/").filter((s) => s.length > 0);
  if (cleanHost.length === 0 || segments.length < 2) return null;
  const repo = segments[segments.length - 1];
  const owner = segments.slice(0, -1).join("/");
  if (!repo || owner.length === 0) return null;
  return { host: cleanHost, owner, repo };
}
function parseRemote(url) {
  if (!url) return null;
  const trimmed = url.trim();
  if (trimmed.length === 0) return null;
  const schemeMatch = trimmed.match(/^([a-z][a-z0-9+.-]*):\/\/(.+)$/i);
  if (schemeMatch) {
    const rest = schemeMatch[2] ?? "";
    const slash = rest.indexOf("/");
    if (slash < 0) return null;
    let authority = rest.slice(0, slash);
    const path = stripTail(rest.slice(slash + 1));
    const at = authority.lastIndexOf("@");
    if (at >= 0) authority = authority.slice(at + 1);
    const colon = authority.indexOf(":");
    const host = colon >= 0 ? authority.slice(0, colon) : authority;
    return fromHostPath(host, path);
  }
  const scpMatch = trimmed.match(/^([^/@]+@)?([^/:]+):(.+)$/);
  if (scpMatch) {
    const host = scpMatch[2] ?? "";
    const path = stripTail(scpMatch[3] ?? "");
    if (host.length > 0 && !path.startsWith("/")) {
      return fromHostPath(host, path);
    }
  }
  return null;
}
function sameRepo(a, b) {
  if (!a || !b) return false;
  const pa = parseRemote(a);
  const pb = parseRemote(b);
  if (pa && pb) {
    return pa.host.toLowerCase() === pb.host.toLowerCase() && pa.owner === pb.owner && pa.repo === pb.repo;
  }
  return stripTail(a.trim()) === stripTail(b.trim());
}
function autoStorageUrl(origin, owner) {
  if (!origin || !owner) return null;
  const trimmed = origin.trim();
  const repo = "claude-team-memory";
  const schemeMatch = trimmed.match(/^([a-z][a-z0-9+.-]*):\/\/(.+)$/i);
  if (schemeMatch) {
    const scheme = schemeMatch[1] ?? "";
    const rest = schemeMatch[2] ?? "";
    const slash = rest.indexOf("/");
    if (slash < 0) return null;
    const authority = rest.slice(0, slash);
    return `${scheme}://${authority}/${owner}/${repo}.git`;
  }
  const scpMatch = trimmed.match(/^([^/@]+@)?([^/:]+):(.+)$/);
  if (scpMatch) {
    const user = scpMatch[1] ?? "git@";
    const host = scpMatch[2] ?? "";
    if (host.length === 0) return null;
    return `${user}${host}:${owner}/${repo}.git`;
  }
  return null;
}

// src/lib/paths.ts
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
function dataDir() {
  const env = process.env.CLAUDE_PLUGIN_DATA;
  return env && env.length > 0 ? env : join(homedir(), ".claude-team-mem");
}
function configPath() {
  return join(dataDir(), "config.json");
}
function claudeConfigDir() {
  const env = process.env.CLAUDE_CONFIG_DIR;
  return env && env.length > 0 ? env : join(homedir(), ".claude");
}
function checkoutDirFromUrl(url) {
  const parsed = parseRemote(url);
  if (!parsed) return null;
  return join(dataDir(), "repos", projectKeyDirSegment(parsed));
}
function projectKeyDirSegment(parsed) {
  const owner = parsed.owner.replace(/\//g, "_");
  return `${parsed.host}__${owner}__${parsed.repo}`;
}
function projectKeyFromParsed(parsed) {
  if (!parsed) return null;
  return `${parsed.owner}/${parsed.repo}`;
}
function projectKey(url) {
  return projectKeyFromParsed(parseRemote(url));
}
function nativeMemoryDir(projectRoot) {
  const abs = resolve(projectRoot);
  return join(claudeConfigDir(), "projects", slugForPath(abs), "memory");
}
function slugForPath(path) {
  return resolve(path).replace(/[/.]/g, "-");
}
function pathInside(child, parent) {
  try {
    const c = resolve(child);
    const p = resolve(parent);
    if (c === p) return true;
    const rel = relative(p, c);
    return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
  } catch {
    return false;
  }
}
function ensureNativeDir(projectRoot) {
  try {
    const memDir = nativeMemoryDir(projectRoot);
    const slugParent = join(memDir, "..");
    if (!existsSync(slugParent)) {
      ctmLog(`native dir parent not found (derivation may be off): ${slugParent}`);
      return null;
    }
    if (!existsSync(memDir)) {
      mkdirSync(memDir, { recursive: true });
    }
    return memDir;
  } catch (err) {
    ctmLog(`ensureNativeDir failed: ${String(err)}`);
    return null;
  }
}

// src/lib/config.ts
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync, writeFileSync } from "node:fs";
var DEFAULT_MAX_INDEX_BYTES = 2e4;
function defaultConfig() {
  return { owners: {}, maxIndexBytes: DEFAULT_MAX_INDEX_BYTES };
}
function readConfig() {
  try {
    const path = configPath();
    if (!existsSync2(path)) return defaultConfig();
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return defaultConfig();
    const obj = parsed;
    const owners = {};
    if (typeof obj.owners === "object" && obj.owners !== null) {
      for (const [k, v] of Object.entries(obj.owners)) {
        if (typeof v === "string" && v.length > 0) owners[k] = v;
      }
    }
    const cfg = { owners };
    if (typeof obj.maxIndexBytes === "number" && Number.isFinite(obj.maxIndexBytes) && obj.maxIndexBytes >= 0) {
      cfg.maxIndexBytes = obj.maxIndexBytes;
    } else {
      cfg.maxIndexBytes = DEFAULT_MAX_INDEX_BYTES;
    }
    return cfg;
  } catch (err) {
    ctmLog(`readConfig failed, using defaults: ${String(err)}`);
    return defaultConfig();
  }
}
function ownerMapping(config, owner) {
  if (!owner) return null;
  const v = config.owners[owner];
  return v && v.length > 0 ? v : null;
}

// src/lib/guard.ts
import { join as join2 } from "node:path";
function isCircular(storageUrl, origin, cwd, dataDir2) {
  if (sameRepo(storageUrl, origin)) return true;
  const reposRoot = join2(dataDir2, "repos");
  if (pathInside(cwd, reposRoot)) return true;
  return false;
}

// src/resolve.ts
import { existsSync as existsSync3 } from "node:fs";
import { join as join3 } from "node:path";
function projectOrigin(projectRoot) {
  const r = git(["config", "--get", "remote.origin.url"], { cwd: projectRoot });
  if (r.status !== 0) return null;
  const url = r.stdout.trim();
  return url.length > 0 ? url : null;
}
function specToStorageUrl(spec, origin, owner) {
  const s = spec.trim();
  if (s.length === 0) return null;
  if (s === "auto") {
    return owner ? autoStorageUrl(origin, owner) : null;
  }
  if (parseRemote(s)) return s;
  if (/^[^/\s:]+\/[^/\s:]+$/.test(s)) {
    const [graftOwner, graftRepo] = s.split("/");
    if (origin) {
      const auto = autoStorageUrl(origin, graftOwner);
      if (auto) return auto.replace(/claude-team-memory\.git$/, `${graftRepo}.git`);
    }
    return null;
  }
  return null;
}
function disabled(reason) {
  return { enabled: false, reason };
}
function resolve2(projectRoot) {
  try {
    const origin = projectOrigin(projectRoot);
    const originParsed = parseRemote(origin);
    const projectOwner = originParsed?.owner ?? null;
    let storageUrl = null;
    let reason = "";
    const envSpec = process.env.CLAUDE_TEAM_MEMORY_REPO;
    if (envSpec && envSpec.trim().length > 0) {
      storageUrl = specToStorageUrl(envSpec.trim(), origin, projectOwner);
      if (!storageUrl) return disabled(`env CLAUDE_TEAM_MEMORY_REPO is set but unparseable: ${envSpec}`);
      reason = `env CLAUDE_TEAM_MEMORY_REPO -> ${storageUrl}`;
    } else {
      if (!projectOwner) return disabled("project has no parseable origin owner");
      const config = readConfig();
      const spec = ownerMapping(config, projectOwner);
      if (!spec) return disabled(`no config mapping for owner "${projectOwner}"`);
      storageUrl = specToStorageUrl(spec, origin, projectOwner);
      if (!storageUrl) return disabled(`config mapping for "${projectOwner}" is unparseable: ${spec}`);
      reason = `owner "${projectOwner}" -> ${spec}`;
    }
    if (isCircular(storageUrl, origin, projectRoot, dataDir())) {
      return disabled(`anti-circular guard: storage repo == project origin or cwd inside a checkout`);
    }
    const checkoutDir = checkoutDirFromUrl(storageUrl);
    const key = projectKey(origin);
    if (!checkoutDir || !key) {
      return disabled(`could not derive checkout/key (storageUrl=${storageUrl}, origin=${origin})`);
    }
    const targetMemoryDir = join3(checkoutDir, key, "memory");
    const nativeDir = nativeMemoryDir(projectRoot);
    const cloned = cloneOnce(storageUrl, checkoutDir);
    if (cloned.status !== 0 && !existsSync3(join3(checkoutDir, ".git"))) {
      ctmLog(`resolve: clone failed and no usable checkout exists: ${cloned.stderr.trim()}`);
      return disabled(`storage checkout unavailable (clone failed): ${cloned.stderr.trim() || "unknown error"}`);
    }
    return {
      enabled: true,
      reason,
      storageUrl,
      checkoutDir,
      projectKey: key,
      targetMemoryDir,
      nativeMemoryDir: nativeDir
    };
  } catch (err) {
    return disabled(`resolve failed: ${String(err)}`);
  }
}

// src/lib/frontmatter.ts
import { readFileSync as readFileSync2 } from "node:fs";
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
    const content = readFileSync2(file, "utf8");
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

// src/load.ts
var MAX_CONTEXT_BYTES = 48e3;
var MAX_CLASH_LINES = 50;
function isMemoryFile(name) {
  return name.endsWith(".md");
}
function listTeamFiles(targetMemoryDir) {
  try {
    if (!existsSync4(targetMemoryDir)) return [];
    return readdirSync(targetMemoryDir, { withFileTypes: true }).filter((d) => (d.isFile() || d.isSymbolicLink()) && isMemoryFile(d.name)).map((d) => d.name).sort((a, b) => a.localeCompare(b));
  } catch (err) {
    ctmLog(`listTeamFiles failed for ${targetMemoryDir}: ${String(err)}`);
    return [];
  }
}
function deriveTitle(file, slug) {
  const mem = readMemory(file);
  if (mem.name && mem.name.trim().length > 0) return mem.name.trim();
  const body = mem.body ?? "";
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    const m = line.match(/^#{1,6}\s+(.+)$/);
    if (m && m[1] && m[1].trim().length > 0) return m[1].trim();
  }
  return slug;
}
function collectTeamEntries(targetMemoryDir) {
  const out = [];
  for (const slug of listTeamFiles(targetMemoryDir)) {
    const target = join4(targetMemoryDir, slug);
    out.push({ slug, target, title: deriveTitle(target, slug) });
  }
  return out;
}
function symlinkTargetAbs(linkPath) {
  try {
    const raw = readlinkSync(linkPath);
    if (isAbsolute2(raw)) return resolvePath(raw);
    return resolvePath(join4(linkPath, ".."), raw);
  } catch {
    return null;
  }
}
function reconcile(nativeDir, checkoutDir, entries) {
  const realClashes = [];
  const unrelatedSymlinkClashes = [];
  const wantedSlugs = new Set(entries.map((e) => e.slug));
  for (const entry of entries) {
    const linkPath = join4(nativeDir, entry.slug);
    try {
      const stat = lstatSync(linkPath, { throwIfNoEntry: false });
      if (!stat) {
        symlinkSync(entry.target, linkPath);
        continue;
      }
      if (stat.isSymbolicLink()) {
        const tgt = symlinkTargetAbs(linkPath);
        if (tgt && pathInside(tgt, checkoutDir)) {
          if (tgt === resolvePath(entry.target)) {
            continue;
          }
          unlinkSync(linkPath);
          symlinkSync(entry.target, linkPath);
          continue;
        }
        unrelatedSymlinkClashes.push(entry.slug);
        continue;
      }
      realClashes.push(entry.slug);
    } catch (err) {
      ctmLog(`reconcile: failed on ${linkPath}: ${String(err)}`);
    }
  }
  try {
    if (existsSync4(nativeDir)) {
      for (const dirent of readdirSync(nativeDir, { withFileTypes: true })) {
        if (!dirent.isSymbolicLink()) continue;
        const name = dirent.name;
        const linkPath = join4(nativeDir, name);
        const tgt = symlinkTargetAbs(linkPath);
        if (!tgt || !pathInside(tgt, checkoutDir)) continue;
        const dangling = !existsSync4(tgt);
        if (dangling && !wantedSlugs.has(name)) {
          try {
            unlinkSync(linkPath);
          } catch (err) {
            ctmLog(`reconcile: prune failed on ${linkPath}: ${String(err)}`);
          }
        }
      }
    }
  } catch (err) {
    ctmLog(`reconcile prune pass failed for ${nativeDir}: ${String(err)}`);
  }
  return { realClashes, unrelatedSymlinkClashes };
}
function indexLine(entry) {
  const mem = readMemory(entry.target);
  const hook = mem.description && mem.description.trim().length > 0 ? mem.description.trim() : "team-shared memory";
  return `- [${entry.title}](${entry.slug}) \u2014 ${hook}`;
}
function buildIndexBody(entries, maxIndexBytes) {
  const lines = entries.map(indexLine);
  if (lines.length === 0) return "";
  if (!(maxIndexBytes > 0)) return lines.join("\n");
  const kept = [];
  let bytes = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const add = Buffer.byteLength(line, "utf8") + (kept.length > 0 ? 1 : 0);
    if (kept.length >= 1 && bytes + add > maxIndexBytes) break;
    kept.push(line);
    bytes += add;
  }
  if (kept.length < lines.length) {
    const remaining = lines.length - kept.length;
    kept.push(`\u2026and ${remaining} more (see the team memory checkout).`);
  }
  return kept.join("\n");
}
function preamble() {
  return [
    "Team-shared memory (synced from your team's private storage repo):",
    "- These facts are shared with your team; treat them as reference, not personal notes.",
    "- Do NOT re-save them into local memory and do NOT re-share them (they are already shared).",
    "- Verify a fact against the current code/state before relying on it.",
    "- On conflict with something local, prefer the newer and more specific fact, and flag it."
  ].join("\n");
}
function clashBullets(slugs, max) {
  const shown = slugs.slice(0, max).map((s) => `- ${s}`);
  if (slugs.length > max) shown.push(`- \u2026and ${slugs.length - max} more.`);
  return shown;
}
function clashSections(rc) {
  const sections = [];
  if (rc.realClashes.length > 0) {
    sections.push(
      [
        "Name clashes (local real file vs. team file with the same name) \u2014 reconcile, do not blindly overwrite:",
        ...clashBullets(rc.realClashes, MAX_CLASH_LINES)
      ].join("\n")
    );
  }
  if (rc.unrelatedSymlinkClashes.length > 0) {
    sections.push(
      [
        "Unrelated symlinks shadowing a team file name (a local symlink points outside the team checkout) \u2014 resolve manually:",
        ...clashBullets(rc.unrelatedSymlinkClashes, MAX_CLASH_LINES)
      ].join("\n")
    );
  }
  return sections;
}
function capContext(context) {
  if (Buffer.byteLength(context, "utf8") <= MAX_CONTEXT_BYTES) return context;
  const note = "\n\n[team-memory: context truncated to fit the session-start budget.]";
  const noteBytes = Buffer.byteLength(note, "utf8");
  const budget = Math.max(0, MAX_CONTEXT_BYTES - noteBytes);
  const lines = context.split("\n");
  const kept = [];
  let bytes = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const add = Buffer.byteLength(line, "utf8") + (kept.length > 0 ? 1 : 0);
    if (kept.length >= 1 && bytes + add > budget) break;
    kept.push(line);
    bytes += add;
  }
  return kept.join("\n") + note;
}
function buildSessionContext(projectRoot) {
  try {
    const res = resolve2(projectRoot);
    if (!res.enabled) {
      ctmLog(`load: disabled (${res.reason})`);
      return { context: null };
    }
    const checkoutDir = res.checkoutDir;
    const targetMemoryDir = res.targetMemoryDir;
    if (!checkoutDir || !targetMemoryDir) {
      ctmLog("load: enabled but missing checkout/target paths; skipping");
      return { context: null };
    }
    backgroundPull(checkoutDir);
    const entries = collectTeamEntries(targetMemoryDir);
    let rc = { realClashes: [], unrelatedSymlinkClashes: [] };
    const nativeDir = ensureNativeDir(projectRoot);
    if (nativeDir) {
      rc = reconcile(nativeDir, checkoutDir, entries);
    } else {
      ctmLog("load: native dir unusable; injecting index only (no symlinking)");
    }
    if (entries.length === 0 && rc.realClashes.length === 0 && rc.unrelatedSymlinkClashes.length === 0) {
      return { context: null };
    }
    const config = readConfig();
    const maxIndexBytes = typeof config.maxIndexBytes === "number" ? config.maxIndexBytes : DEFAULT_MAX_INDEX_BYTES;
    const parts = [preamble()];
    if (entries.length > 0) {
      const body = buildIndexBody(entries, maxIndexBytes);
      if (body.length > 0) {
        parts.push(["Available team memory:", body].join("\n"));
      }
    }
    parts.push(...clashSections(rc));
    return { context: capContext(parts.join("\n\n")) };
  } catch (err) {
    ctmLog(`buildSessionContext failed: ${String(err)}`);
    return { context: null };
  }
}
function backgroundPull(checkoutDir) {
  try {
    if (!existsSync4(checkoutDir)) return;
    const child = spawn("git", ["pull", "--ff-only"], {
      cwd: checkoutDir,
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -oBatchMode=yes -oStrictHostKeyChecking=accept-new"
      }
    });
    child.on("error", () => {
    });
    child.unref();
  } catch (err) {
    ctmLog(`backgroundPull failed to spawn: ${String(err)}`);
  }
}

// src/bin/load.ts
function cwdFromStdin() {
  let raw = "";
  try {
    raw = readFileSync3(0, "utf8");
  } catch {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null) {
      const cwd = parsed.cwd;
      if (typeof cwd === "string" && cwd.trim().length > 0) return cwd;
    }
  } catch {
  }
  return null;
}
function main() {
  try {
    const projectRoot = cwdFromStdin() ?? process.cwd();
    const { context } = buildSessionContext(projectRoot);
    if (context !== null && context.length > 0) {
      const payload = {
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: context
        }
      };
      writeFileSync2(1, JSON.stringify(payload));
    }
  } catch (err) {
    ctmLog(`load entry failed: ${String(err)}`);
  }
}
main();
process.exit(0);
