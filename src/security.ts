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

/**
 * Windows lets several different strings name the same file, and every fence in this module
 * compares names as text. Two spellings are refused outright:
 *
 * - `name::$DATA` and `name:stream` are NTFS stream syntax. `.env::$DATA` IS `.env`, and
 *   `.git::$INDEX_ALLOCATION` IS the `.git` directory, but neither looks like it to a name check.
 * - A segment ending in a dot or a space. Win32 drops those, so `.git.` can reach `.git`; when
 *   it does not, the result is a file Explorer can neither open nor delete.
 *
 * Returns a description of the first problem, or null. This is plain string logic, so it is
 * tested on every platform; callers apply it only on Windows, where these spellings alias.
 */
export function windowsPathProblem(target: string): string | null {
  const rest = target.slice(path.win32.parse(target).root.length);
  for (const segment of rest.split(/[\\/]+/)) {
    if (!segment || segment === "." || segment === "..") continue;
    if (segment.includes(":")) {
      return `"${segment}" contains ":" (NTFS stream syntax such as file::$DATA is not accepted)`;
    }
    if (/[. ]$/.test(segment)) {
      return `"${segment}" ends in a dot or a space, which Windows silently drops`;
    }
  }
  return null;
}

/** Throws ERR_PATH_ALIAS when `target` uses one of the spellings above. A no-op off Windows. */
export function assertPlainWindowsPath(target: string): void {
  if (process.platform !== "win32") return;
  const problem = windowsPathProblem(target);
  if (problem) throw new Error(`ERR_PATH_ALIAS: ${problem}`);
}

/**
 * Looks for an 8.3 short name in the last `count` segments of a path. `typed` is the path as it
 * was resolved from the request and `onDisk` is the same path with every name as the file system
 * stores it. `GIT~1` and `.git` are one directory; only the second trips the protected-path
 * check. A segment counts as an alias when it has the short-name shape (`~` and a digit) and is
 * not the name on disk; a directory really called `v~1` is left alone. Returns the alias or null.
 */
export function findShortNameAlias(typed: string, onDisk: string, count: number): string | null {
  const a = typed.split(/[\\/]+/).filter(Boolean);
  const b = onDisk.split(/[\\/]+/).filter(Boolean);
  for (let i = 1; i <= count; i++) {
    const typedName = a[a.length - i];
    const diskName = b[b.length - i];
    if (typedName === undefined || diskName === undefined) return null;
    if (typedName.toLowerCase() !== diskName.toLowerCase() && /~\d/.test(typedName)) return typedName;
  }
  return null;
}

/**
 * Rewrites every 8.3 short name in a Windows path to the name the file system stores, so
 * `D:\work\RUNNER~1\project` becomes `D:\work\runneradmin\project`. The drive, and every
 * segment that is not a short name, stay exactly as written. Segments that do not exist are
 * kept as they are. Elsewhere than Windows this returns its argument.
 *
 * A short name is only a problem when a name check is about to be made on the path, because
 * `GIT~1` is `.git` without being called `.git`. Expanding first means the checks that follow
 * see the real names, which is stricter than refusing every path that has a short name in it:
 * a profile folder with a long name is spelled that way by Windows itself in `%TEMP%`.
 */
export function expandShortNames(target: string): string {
  if (process.platform !== "win32") return target;
  const root = path.win32.parse(target).root;
  let out = root;
  for (const segment of target.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
    const typed = path.join(out, segment);
    let name = segment;
    if (/~\d/.test(segment)) {
      try {
        const stored = path.basename(fs.realpathSync.native(typed));
        const viaStored = path.join(out, stored);
        // Taken only when it is the same entry under its other name, not a link's target.
        const a = fs.lstatSync(typed);
        const b = fs.lstatSync(viaStored);
        if (stored && a.ino === b.ino && a.dev === b.dev) name = stored;
      } catch {
        // Missing, or not readable: nothing to expand.
      }
    }
    out = path.join(out, name);
  }
  return out;
}

/**
 * On Windows, the short-name alias (if any) that `resolved` uses below `baseReal`, else null.
 * Only the part that exists can be an alias; the names of files still to be created are new.
 */
export function shortNameAliasBelow(baseReal: string, resolved: string): string | null {
  if (process.platform !== "win32") return null;
  let existing = resolved;
  while (!lstatOrNull(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return null;
    existing = parent;
  }
  const rel = path.relative(baseReal, existing);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  let onDisk: string;
  try {
    onDisk = fs.realpathSync.native(existing);
  } catch {
    return null;
  }
  return findShortNameAlias(existing, onDisk, rel.split(path.sep).filter(Boolean).length);
}

export function resolveWorkspaceRoot(cwd?: string): string {
  const requested = cwd?.trim() ? cwd : undefined;
  if (requested) assertPlainWindowsPath(requested.trim());
  return fs.realpathSync(requested ?? process.cwd());
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
  assertPlainWindowsPath(trimmed);

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
  // Checked again on where the path really leads: a link's target can carry the same spellings.
  assertPlainWindowsPath(exactRel);
  const alias = shortNameAliasBelow(workspaceReal, resolvedCandidate);
  if (alias) {
    throw new Error(`ERR_PATH_ALIAS: "${alias}" is a Windows short name; use the file's real name`);
  }
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
  if (secretNameMatches(parts)) return true;
  // The same file under a Windows spelling: `.env::$DATA`, `id_rsa.`, `deploy.pem `.
  const plain = parts.map(plainSegment);
  return plain.some((name, i) => name !== parts[i]) && secretNameMatches(plain);
}

/** A path segment as Windows would open it, without a `:stream` suffix or trailing dots and spaces. */
function plainSegment(segment: string): string {
  const colon = segment.indexOf(":");
  const name = (colon === -1 ? segment : segment.slice(0, colon)).replace(/[. ]+$/, "");
  return name || segment;
}

function secretNameMatches(parts: string[]): boolean {
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
  // Also matched as Windows would open them, so `.git::$INDEX_ALLOCATION` and `.turnpack.json.`
  // are caught here even if a caller forgot to refuse those spellings first.
  const plain = parts.map(plainSegment);
  if (parts.includes(".git") || plain.includes(".git")) return true;
  return parts[parts.length - 1] === ".turnpack.json" || plain[plain.length - 1] === ".turnpack.json";
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
