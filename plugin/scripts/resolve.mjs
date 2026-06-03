#!/usr/bin/env node

// src/bin/resolve.ts
import { writeFileSync as writeFileSync2 } from "node:fs";

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
  const repo = "team-memory";
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
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, relative, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";
var PLUGIN_NAME = "claude-team-mem";
var warnedForeignPluginDataDir = false;
function dataDir() {
  const env = process.env.CLAUDE_PLUGIN_DATA;
  const inferred = inferPluginDataDir();
  if (env && env.length > 0) {
    if (inferred && isForeignClaudePluginDataDir(env, inferred)) {
      if (!warnedForeignPluginDataDir) {
        ctmLog(`ignoring foreign CLAUDE_PLUGIN_DATA=${env}; using ${inferred}`);
        warnedForeignPluginDataDir = true;
      }
      return inferred;
    }
    return env;
  }
  return inferred ?? join(homedir(), ".claude-team-mem");
}
function configPath() {
  return join(dataDir(), "config.json");
}
function isForeignClaudePluginDataDir(env, inferred) {
  const actual = resolve(env);
  const expected = resolve(inferred);
  if (actual === expected) return false;
  const marker = `${sep}plugins${sep}data${sep}`;
  if (!actual.includes(marker)) return false;
  return !basename(actual).includes(PLUGIN_NAME);
}
function inferPluginDataDir() {
  return dataDirFromPluginRoot(process.env.CLAUDE_PLUGIN_ROOT) ?? dataDirFromPluginRoot(dirname(fileURLToPath(import.meta.url)));
}
function dataDirFromPluginRoot(path) {
  if (!path) return null;
  const parts = resolve(path).split(sep);
  const cache = parts.lastIndexOf("cache");
  if (cache > 0 && parts[cache - 1] === "plugins" && parts[cache + 1] && parts[cache + 2]) {
    return join(parts.slice(0, cache).join(sep) || sep, "data", `${parts[cache + 1]}-${parts[cache + 2]}`);
  }
  const marketplaces = parts.lastIndexOf("marketplaces");
  if (marketplaces > 0 && parts[marketplaces - 1] === "plugins" && parts[marketplaces + 1]) {
    return join(parts.slice(0, marketplaces).join(sep) || sep, "data", `${parts[marketplaces + 1]}-inline`);
  }
  return null;
}
function claudeConfigDir() {
  const env = process.env.CLAUDE_CONFIG_DIR;
  return env && env.length > 0 ? env : join(homedir(), ".claude");
}
function checkoutDirFromUrl(url) {
  const parsed = parseRemote(url);
  if (parsed) return join(dataDir(), "repos", projectKeyDirSegment(parsed));
  const localPath = normalizeLocalRepoPath(url);
  if (localPath) return join(dataDir(), "repos", localRepoDirSegment(localPath));
  return null;
}
function projectKeyDirSegment(parsed) {
  const owner = parsed.owner.replace(/\//g, "_");
  return `${parsed.host}__${owner}__${parsed.repo}`;
}
function normalizeLocalRepoPath(spec, baseDir = process.cwd()) {
  if (!spec) return null;
  const s = spec.trim();
  if (s.length === 0) return null;
  if (s.startsWith("file://")) {
    try {
      return resolve(fileURLToPath(s));
    } catch {
      return null;
    }
  }
  if (s === "~") return homedir();
  if (s.startsWith("~/")) return resolve(homedir(), s.slice(2));
  if (isAbsolute(s)) return resolve(s);
  if (s.startsWith("./") || s.startsWith("../")) return resolve(baseDir, s);
  return null;
}
function localRepoDirSegment(localPath) {
  const name = safeSegment(stripGitSuffix(basename(localPath))) || "repo";
  const hash = createHash("sha256").update(resolve(localPath)).digest("hex").slice(0, 12);
  return `local__${name}__${hash}`;
}
function stripGitSuffix(s) {
  return s.endsWith(".git") ? s.slice(0, -4) : s;
}
function safeSegment(s) {
  return s.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
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

// src/lib/config.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
var DEFAULT_MAX_INDEX_BYTES = 2e4;
function defaultConfig() {
  return { owners: {}, maxIndexBytes: DEFAULT_MAX_INDEX_BYTES };
}
function readConfig() {
  try {
    const path = configPath();
    if (!existsSync(path)) return defaultConfig();
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
  const localStoragePath = normalizeLocalRepoPath(storageUrl);
  if (localStoragePath && pathInside(cwd, localStoragePath)) return true;
  const reposRoot = join2(dataDir2, "repos");
  if (pathInside(cwd, reposRoot)) return true;
  return false;
}

// src/resolve.ts
import { existsSync as existsSync2 } from "node:fs";
import { join as join3 } from "node:path";
function projectOrigin(projectRoot) {
  const r = git(["config", "--get", "remote.origin.url"], { cwd: projectRoot });
  if (r.status !== 0) return null;
  const url = r.stdout.trim();
  return url.length > 0 ? url : null;
}
function specToStorageUrl(spec, origin, owner, baseDir = process.cwd()) {
  const s = spec.trim();
  if (s.length === 0) return null;
  if (s === "auto") {
    return owner ? autoStorageUrl(origin, owner) : null;
  }
  const localPath = normalizeLocalRepoPath(s, baseDir);
  if (localPath) return localPath;
  if (parseRemote(s)) return s;
  if (/^[^/\s:]+\/[^/\s:]+$/.test(s)) {
    const [graftOwner, graftRepo] = s.split("/");
    if (origin) {
      const auto = autoStorageUrl(origin, graftOwner);
      if (auto) return auto.replace(/team-memory\.git$/, `${graftRepo}.git`);
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
      storageUrl = specToStorageUrl(envSpec.trim(), origin, projectOwner, projectRoot);
      if (!storageUrl) return disabled(`env CLAUDE_TEAM_MEMORY_REPO is set but unparseable: ${envSpec}`);
      reason = `env CLAUDE_TEAM_MEMORY_REPO -> ${storageUrl}`;
    } else {
      if (!projectOwner) return disabled("project has no parseable origin owner");
      const config = readConfig();
      const spec = ownerMapping(config, projectOwner);
      if (!spec) return disabled(`no config mapping for owner "${projectOwner}"`);
      storageUrl = specToStorageUrl(spec, origin, projectOwner, projectRoot);
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
    if (cloned.status !== 0 && !existsSync2(join3(checkoutDir, ".git"))) {
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

// src/bin/resolve.ts
function cwdArg(argv) {
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--cwd") {
      const v = argv[i + 1];
      return typeof v === "string" && v.length > 0 && !v.startsWith("--") ? v : null;
    }
    if (typeof tok === "string" && tok.startsWith("--cwd=")) {
      const v = tok.slice("--cwd=".length);
      if (v.length > 0) return v;
    }
  }
  return null;
}
function main() {
  let result;
  try {
    const projectRoot = cwdArg(process.argv.slice(2)) ?? process.cwd();
    result = resolve2(projectRoot);
  } catch (err) {
    ctmLog(`resolve entry failed: ${String(err)}`);
    result = { enabled: false, reason: `resolve entry failed: ${String(err)}` };
  }
  writeFileSync2(1, JSON.stringify(result) + "\n");
}
main();
process.exit(0);
