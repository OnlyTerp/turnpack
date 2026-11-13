import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expandShortNames, findShortNameAlias, isInsideDir, shortNameAliasBelow, windowsPathProblem } from "./security.js";

/**
 * The set of directories a server instance is allowed to work in.
 *
 * Tool calls carry a `root` argument, and that argument is written by the model. If it were
 * trusted as-is, the "workspace jail" would be wherever the model said it was. So the boundary
 * is fixed on the server side, from the first of these that applies:
 *
 *   1. `TURNPACK_ROOT`: explicit choice by whoever configured the server.
 *   2. MCP `roots`: the folders the client says this session is working on.
 *   3. `CLAUDE_PROJECT_DIR`: set by Claude Code for the servers it launches, because it makes
 *      no promise about the working directory it starts them in. Believed only when the client
 *      that connects is Claude, since the variable is inherited by anything started from a
 *      Claude Code terminal.
 *   4. The directory the server was started in, when that is a place a project could be.
 *
 * A tool argument may then pick a directory inside that boundary, never outside it.
 *
 * Some desktop apps start their servers in the home directory, the file system root or their
 * own install folder, and name no project at all. None of those is a workspace, and treating
 * one as a workspace would mean searching and editing a whole home directory. In that case the
 * policy has no root (`source: "none"`): every call must name the project directory itself, the
 * call is confined to that directory, and broad or sensitive directories are refused. This is
 * the one situation in which the model's argument chooses the boundary, and setting
 * `TURNPACK_ROOT` removes it.
 */
export interface RootPolicy {
  roots: string[];
  source: "env" | "client" | "project" | "cwd" | "none";
}

function realDirOrNull(candidate: string): string | null {
  try {
    const real = fs.realpathSync(candidate);
    return fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/** A path with links resolved and Windows short names written out, for comparing two spellings of one place. */
function realOrSelf(candidate: string): string {
  try {
    return expandShortNames(fs.realpathSync(candidate));
  } catch {
    return expandShortNames(path.resolve(candidate));
  }
}

// Under the home directory: where credentials live, not projects.
const CREDENTIAL_DIRS = [".ssh", ".aws", ".gnupg", ".kube", ".docker", ".azure", ".config/gcloud"];

/**
 * True for a directory that is too broad or too sensitive to be a workspace: a file system
 * root, the home directory, operating system and application folders, and the folders where
 * credentials are kept. A temporary directory is never broad, wherever the system puts it.
 */
export function isBroadDirectory(dir: string): boolean {
  const real = realOrSelf(dir);
  if (path.parse(real).root === real) return true;

  const home = realOrSelf(os.homedir());
  if (real === home || (process.platform === "win32" && real.toLowerCase() === home.toLowerCase())) return true;
  const within = (base: string | undefined): boolean => Boolean(base) && isInsideDir(realOrSelf(base as string), real);
  if (CREDENTIAL_DIRS.some((name) => within(path.join(home, name)))) return true;
  if (within(os.tmpdir())) return false;

  if (process.platform === "win32") {
    const env = process.env;
    return [
      env.SystemRoot,
      env.ProgramFiles,
      env["ProgramFiles(x86)"],
      env.ProgramData,
      env.APPDATA,
      env.LOCALAPPDATA,
    ].some(within);
  }
  const systemDirs =
    process.platform === "darwin"
      ? ["/Applications", "/System", "/Library", "/usr", "/bin", "/sbin", path.join(home, "Library")]
      : ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/boot", "/proc", "/sys", "/dev", "/snap"];
  return systemDirs.some(within);
}

export function createRootPolicy(
  cwd: string = process.cwd(),
  options: { ignoreProjectEnv?: boolean } = {},
): RootPolicy {
  const fromEnv = process.env.TURNPACK_ROOT?.trim();
  if (fromEnv) {
    const roots = fromEnv
      .split(path.delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => realDirOrNull(path.resolve(cwd, entry)))
      .filter((entry): entry is string => entry !== null);
    if (roots.length === 0) {
      throw new Error(`TURNPACK_ROOT="${fromEnv}" does not name an existing directory`);
    }
    return { roots: [...new Set(roots)], source: "env" };
  }
  const projectDir = options.ignoreProjectEnv ? undefined : process.env.CLAUDE_PROJECT_DIR?.trim();
  if (projectDir) {
    const real = realDirOrNull(projectDir);
    if (real) return { roots: [real], source: "project" };
  }
  const real = fs.realpathSync(cwd);
  return isBroadDirectory(real) ? { roots: [], source: "none" } : { roots: [real], source: "cwd" };
}

/**
 * Applies the folders reported by an MCP client (`roots/list`). An explicit `TURNPACK_ROOT`
 * always wins, and an empty or unusable list leaves the current policy untouched.
 */
export function applyClientRoots(policy: RootPolicy, uris: unknown): RootPolicy {
  if (policy.source === "env" || !Array.isArray(uris)) return policy;
  const roots: string[] = [];
  for (const item of uris) {
    const uri = (item as { uri?: unknown } | null)?.uri;
    if (typeof uri !== "string" || !uri.startsWith("file:")) continue;
    let fsPath: string;
    try {
      fsPath = fileURLToPath(uri);
    } catch {
      continue;
    }
    const real = realDirOrNull(fsPath);
    if (real) roots.push(real);
  }
  if (roots.length === 0) return policy;
  return { roots: [...new Set(roots)], source: "client" };
}

const NO_WORKSPACE_HINT =
  "This server was not started inside a project and the app named none, so every call must pass root: the absolute path of the project directory. Setting TURNPACK_ROOT pins it instead.";

/** True if a path still reaches some entry through a short name after `expandShortNames`. */
function stillAliased(candidate: string): boolean {
  try {
    const onDisk = fs.realpathSync.native(candidate);
    return findShortNameAlias(candidate, onDisk, candidate.split(/[\\/]+/).filter(Boolean).length) !== null;
  } catch {
    return false;
  }
}

/** For a server with no workspace: the directory the call names, if it may be one. */
function resolveNamedProject(requested: unknown): string {
  if (requested === undefined || requested === null) {
    throw new Error(`ERR_NO_WORKSPACE: ${NO_WORKSPACE_HINT}`);
  }
  if (typeof requested !== "string") {
    throw new Error("root must be a string path");
  }
  const trimmed = requested.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) {
    throw new Error(
      `ERR_NO_WORKSPACE: "${requested}" is not an absolute path, and there is no workspace to resolve it against. ${NO_WORKSPACE_HINT}`,
    );
  }
  // Short names are written out before anything is checked: Windows itself spells a temp or
  // profile folder that way, and the checks below must see `.git`, not `GIT~1`. NTFS stream
  // syntax and trailing dots have no honest use in a folder name, so those are refused.
  const streamOrDot = process.platform === "win32" && windowsPathProblem(trimmed) !== null;
  const expanded = streamOrDot ? null : realDirOrNull(expandShortNames(path.resolve(trimmed)));
  const real = expanded === null ? null : expandShortNames(expanded);
  if (!real || (process.platform === "win32" && stillAliased(real))) {
    throw new Error(
      `ERR_ROOT_NOT_A_DIRECTORY: "${requested}" is not an existing directory. Pass the real, absolute path of the project directory.`,
    );
  }
  if (isBroadDirectory(real)) {
    throw new Error(
      `ERR_ROOT_TOO_BROAD: "${requested}" is a home, system or credentials directory, not a project. Pass the directory of the project itself.`,
    );
  }
  return real;
}

/**
 * Turns the model-supplied `root` argument into a directory that is guaranteed to sit inside
 * the policy. No argument means the primary root. Relative arguments are resolved against the
 * primary root. With no workspace at all, see `resolveNamedProject`.
 */
export function resolveToolRoot(policy: RootPolicy, requested?: unknown): string {
  if (policy.source === "none") return resolveNamedProject(requested);

  const primary = policy.roots[0];
  if (!primary) {
    throw new Error("ERR_NO_WORKSPACE_ROOT: server has no workspace root configured");
  }
  if (requested === undefined || requested === null) return primary;
  if (typeof requested !== "string") {
    throw new Error("root/cwd must be a string path");
  }
  const trimmed = requested.trim();
  if (!trimmed || trimmed === ".") return primary;

  // On Windows, `.git::$INDEX_ALLOCATION` and `GIT~1` both open the `.git` directory without
  // being called `.git`. A root spelled that way would hide the directory from every name check
  // made on the paths below it, so those spellings are refused like any other off-limits root.
  const aliased = process.platform === "win32" && windowsPathProblem(trimmed) !== null;
  const candidate = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(primary, trimmed);
  const real = aliased ? null : realDirOrNull(candidate);
  if (real) {
    const root = policy.roots.find((entry) => isInsideDir(entry, real));
    if (root && shortNameAliasBelow(root, real) === null) return real;
  }
  // The same message whether the directory is missing or merely off-limits, so the answer
  // cannot be used to probe what exists outside the workspace.
  throw new Error(
    `ERR_ROOT_OUTSIDE_WORKSPACE: "${requested}" is not a directory inside this server's workspace (${policy.roots.join(", ")}). ` +
      "Omit root/cwd to use the workspace, or start the server there (or set TURNPACK_ROOT).",
  );
}

/**
 * The directories whose `.turnpack.json` governs a call. Normally the server's roots. With no
 * workspace the call named its own directory, so every directory above it counts as well:
 * otherwise naming a subdirectory would be a way out from under a project's verify allowlist.
 */
export function configScope(policy: RootPolicy, toolRoot: string): string[] {
  return policy.source === "none" ? [path.parse(toolRoot).root] : policy.roots;
}
