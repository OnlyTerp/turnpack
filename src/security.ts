import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_SHARD_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_SHARD_CACHE_BYTES = 10 * 1024 * 1024;

const SAFE_ENV_NAMES = new Set([
  ".env.example",
  ".env.sample",
  ".env.template",
  ".env.schema",
]);

const EXACT_SECRET_NAMES = new Set([
  ".env",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "id_dsa",
  ".git-credentials",
  ".npmrc",
  ".pypirc",
  ".netrc",
  "credentials.json",
]);

const SECRET_EXTENSIONS = [".pem", ".key", ".p12", ".pfx", ".kdbx"];

export interface SafePathResult {
  absPath: string;
  relPath: string;
}

export function resolveWorkspaceRoot(cwd?: string): string {
  const base = cwd && cwd.trim() ? cwd : process.cwd();
  return fs.realpathSync(base);
}

function realpathWithSuffix(targetPath: string): string {
  let cursor = path.resolve(targetPath);
  const trailing: string[] = [];

  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      throw new Error(`ERR_PATH_OUTSIDE_WORKSPACE: Root does not exist for "${targetPath}"`);
    }
    trailing.push(path.basename(cursor));
    cursor = parent;
  }

  const realBase = fs.realpathSync(cursor);
  if (trailing.length === 0) {
    return realBase;
  }
  return path.resolve(realBase, ...trailing.reverse());
}

export function resolveSafePath(workspaceRoot: string, targetPath: string): SafePathResult {
  const workspaceReal = fs.realpathSync(workspaceRoot);
  const trimmed = targetPath.trim();
  if (!trimmed) {
    return { absPath: workspaceReal, relPath: "." };
  }

  const rawCandidate = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(workspaceReal, trimmed);

  const resolvedCandidate = realpathWithSuffix(rawCandidate);
  const compareBase = process.platform === "win32" ? workspaceReal.toLowerCase() : workspaceReal;
  const compareTarget =
    process.platform === "win32" ? resolvedCandidate.toLowerCase() : resolvedCandidate;

  const checkRel = path.relative(compareBase, compareTarget);
  if (
    checkRel !== "" &&
    (checkRel === ".." ||
      checkRel.startsWith(`..${path.sep}`) ||
      checkRel.startsWith("../") ||
      checkRel.startsWith("..\\") ||
      path.isAbsolute(checkRel))
  ) {
    throw new Error(
      `ERR_PATH_OUTSIDE_WORKSPACE: "${targetPath}" resolves outside workspace root "${workspaceReal}"`,
    );
  }

  const exactRel = path.relative(workspaceReal, resolvedCandidate);
  const relPath = exactRel ? exactRel.split(path.sep).join("/") : ".";
  return { absPath: resolvedCandidate, relPath };
}

export function isSecretPath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  if (!normalized || normalized === ".") {
    return false;
  }

  const parts = normalized.split("/").filter(Boolean);
  const base = parts[parts.length - 1] ?? "";
  if (!base) {
    return false;
  }

  if (SAFE_ENV_NAMES.has(base) || base.endsWith(".pub")) {
    return false;
  }

  if (EXACT_SECRET_NAMES.has(base)) {
    return true;
  }

  if (base.startsWith(".env.")) {
    return true;
  }

  if (base.startsWith("service-account") && base.endsWith(".json")) {
    return true;
  }

  for (const ext of SECRET_EXTENSIONS) {
    if (base.endsWith(ext)) {
      return true;
    }
  }

  if (normalized === ".aws/credentials" || normalized.endsWith("/.aws/credentials")) {
    return true;
  }

  return false;
}

export function getShardCacheDir(): string {
  const override = process.env.TURNPACK_CACHE_DIR?.trim();
  if (override) {
    return path.resolve(override);
  }
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(localAppData, "turnpack", "shards");
  }
  const xdgCache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(xdgCache, "turnpack", "shards");
}

function sweepShardCache(cacheDir: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(cacheDir, { withFileTypes: true });
  } catch {
    return;
  }

  const now = Date.now();
  const kept: Array<{ filePath: string; size: number; mtimeMs: number }> = [];
  let totalBytes = 0;

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = path.join(cacheDir, entry.name);
    try {
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > MAX_SHARD_AGE_MS) {
        fs.unlinkSync(filePath);
      } else {
        kept.push({ filePath, size: stat.size, mtimeMs: stat.mtimeMs });
        totalBytes += stat.size;
      }
    } catch {
      // Best-effort cleanup; ignore files deleted concurrently.
    }
  }

  if (totalBytes <= MAX_SHARD_CACHE_BYTES) {
    return;
  }

  kept.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const item of kept) {
    if (totalBytes <= MAX_SHARD_CACHE_BYTES) break;
    try {
      fs.unlinkSync(item.filePath);
      totalBytes -= item.size;
    } catch {
      // Ignore concurrent removal.
    }
  }
}

export function writePrivateShard(prefix: string, content: string): string {
  const cacheDir = getShardCacheDir();
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  sweepShardCache(cacheDir);

  const safePrefix = prefix.replace(/[^a-zA-Z0-9_-]/g, "") || "pack";
  const stamp = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
  const shardPath = path.join(cacheDir, `${safePrefix}-${stamp}.txt`);
  fs.writeFileSync(shardPath, content, { encoding: "utf8", mode: 0o600 });
  return shardPath;
}
