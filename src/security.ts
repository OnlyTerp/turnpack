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
  ".env.defaults",
  "example.env",
  "sample.env",
  "template.env",
]);

const EXACT_SECRET_NAMES = new Set([
  ".env",
  ".envrc",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "id_dsa",
  ".git-credentials",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".pgpass",
  ".htpasswd",
  ".dockercfg",
  "credentials.json",
  "kubeconfig",
  "secrets.json",
  "secrets.yml",
  "secrets.yaml",
  "secrets.toml",
]);

const SECRET_EXTENSIONS = [
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".kdbx",
  ".ppk",
  ".jks",
  ".keystore",
  ".tfstate",
  ".tfstate.backup",
  ".tfvars",
  ".env",
];

/** Directory-qualified secret files: matched on the last two path segments. */
const SECRET_PARENT_AND_NAME = new Set([
  ".aws/credentials",
  ".docker/config.json",
  ".kube/config",
  ".git/config",
]);

export interface SafePathResult {
  absPath: string;
  relPath: string;
}

export function resolveWorkspaceRoot(cwd?: string): string {
  const base = cwd && cwd.trim() ? cwd : process.cwd();
  return fs.realpathSync(base);
}

const MAX_LINK_HOPS = 40;

function lstatOrNull(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

/**
 * Resolves a path that may not exist yet to the place it would really live.
 *
 * The deepest existing part is found with lstat, not exists(): exists() follows links, so it
 * calls a dangling symlink "not there", and the link would then pass for an ordinary new name.
 * A write to that name follows the link and lands wherever it points, which may be outside the
 * workspace or inside .git. So a link whose target is missing is followed here by hand, and the
 * caller's boundary checks see the destination instead of the link.
 */
function realpathWithSuffix(targetPath: string, hops = 0): string {
  if (hops > MAX_LINK_HOPS) {
    throw new Error(`ERR_PATH_OUTSIDE_WORKSPACE: too many symbolic links while resolving "${targetPath}"`);
  }
  let cursor = path.resolve(targetPath);
  const trailing: string[] = [];

  let stat = lstatOrNull(cursor);
  while (!stat) {
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      throw new Error(`ERR_PATH_OUTSIDE_WORKSPACE: Root does not exist for "${targetPath}"`);
    }
    trailing.push(path.basename(cursor));
    cursor = parent;
    stat = lstatOrNull(cursor);
  }

  let realBase: string;
  try {
    realBase = fs.realpathSync(cursor);
  } catch (err) {
    if (!stat.isSymbolicLink()) throw err;
    const linkTarget = fs.readlinkSync(cursor);
    const parentReal = fs.realpathSync(path.dirname(cursor));
    realBase = realpathWithSuffix(path.resolve(parentReal, linkTarget), hops + 1);
  }
  return trailing.length === 0 ? realBase : path.resolve(realBase, ...trailing.reverse());
}

/**
 * True when `target` is `base` itself or lives underneath it. Both arguments must already be
 * real (symlink-resolved) absolute paths; comparison is case-insensitive on Windows.
 */
export function isInsideDir(base: string, target: string): boolean {
  const compareBase = process.platform === "win32" ? base.toLowerCase() : base;
  const compareTarget = process.platform === "win32" ? target.toLowerCase() : target;
  const rel = path.relative(compareBase, compareTarget);
  if (rel === "") return true;
  return !(
    rel === ".." ||
    rel.startsWith(`..${path.sep}`) ||
    rel.startsWith("../") ||
    rel.startsWith("..\\") ||
    path.isAbsolute(rel)
  );
}

export function resolveSafePath(workspaceRoot: string, targetPath: string): SafePathResult {
  if (typeof targetPath !== "string") {
    throw new Error("ERR_INVALID_PATH: path must be a string");
  }
  const workspaceReal = fs.realpathSync(workspaceRoot);
  const trimmed = targetPath.trim();
  if (!trimmed) {
    return { absPath: workspaceReal, relPath: "." };
  }

  const rawCandidate = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(workspaceReal, trimmed);

  const resolvedCandidate = realpathWithSuffix(rawCandidate);
  if (!isInsideDir(workspaceReal, resolvedCandidate)) {
    throw new Error(
      `ERR_PATH_OUTSIDE_WORKSPACE: "${targetPath}" resolves outside workspace root "${workspaceReal}"`,
    );
  }

  const exactRel = path.relative(workspaceReal, resolvedCandidate);
  const relPath = exactRel ? exactRel.split(path.sep).join("/") : ".";
  return { absPath: resolvedCandidate, relPath };
}

/**
 * Whether a path names a file that usually holds credentials.
 *
 * Pass `rootDir` (the directory `relPath` is relative to) whenever it is known. Some rules need
 * the parent directory's name (`.aws/credentials`, `.git/config`), and a caller that has chosen
 * `.aws` itself as its root would otherwise present that file as a bare `credentials`.
 */
export function isSecretPath(relPath: string, rootDir?: string): boolean {
  const relNormalized = relPath.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  if (!relNormalized || relNormalized === ".") {
    return false;
  }
  const normalized = rootDir
    ? `${path.basename(rootDir).toLowerCase()}/${relNormalized}`
    : relNormalized;

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

  const parent = parts[parts.length - 2];
  if (parent && SECRET_PARENT_AND_NAME.has(`${parent}/${base}`)) {
    return true;
  }

  return false;
}

/**
 * Paths `ship` refuses to modify no matter what the caller passes, because changing them
 * changes what runs later rather than what the code says:
 * - `.turnpack.json` holds the verify allowlist, so an edit could switch the guardrail off.
 * - anything inside a `.git/` directory (hooks, config) executes on the next ordinary git
 *   command.
 * Both are matched at any depth: a nested repository's hooks are as dangerous as the root's,
 * and a `.turnpack.json` planted in a subdirectory must not be able to stand in for the real one.
 *
 * Callers should pass the absolute path. A path relative to the call's own root is not enough,
 * because the caller chooses that root and could choose `.git` itself.
 */
export function isProtectedPath(filePath: string): boolean {
  const parts = filePath.replace(/\\/g, "/").toLowerCase().split("/").filter(Boolean);
  if (parts.includes(".git")) return true;
  return parts[parts.length - 1] === ".turnpack.json";
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
