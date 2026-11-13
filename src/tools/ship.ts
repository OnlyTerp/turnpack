import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  isInsideDir,
  isProtectedPath,
  isSecretPath,
  resolveSafePath,
  resolveWorkspaceRoot,
} from "../security.js";
import { describeChecks, detectChecks } from "../checks.js";
import {
  isRecord,
  optionalBoolean,
  optionalList,
  optionalNumber,
  optionalString,
  optionalStringList,
  pick,
  requiredString,
  ROOT_KEYS,
  unknownWorkKeys,
  unwrapJson,
} from "../validate.js";
import { suggestPaths } from "../workspace.js";
import { applySearchReplace, HOW_LABEL } from "./edit-match.js";
import { applyHunks, parsePatch, type PatchFile } from "./patch.js";

export interface ShipWriteOp {
  path: string;
  content: string;
  expected_sha256?: string;
}

export interface ShipEditChange {
  search: string;
  replace: string;
  replace_all?: boolean;
}

export interface ShipEditOp {
  path: string;
  search?: string;
  replace?: string;
  replace_all?: boolean;
  expected_mtime_ms?: number;
  expected_sha256?: string;
  changes?: ShipEditChange[];
}

export interface ShipMoveOp {
  from: string;
  to: string;
}

export interface ShipArgs {
  cwd?: string;
  writes?: ShipWriteOp[];
  edits?: ShipEditOp[];
  moves?: ShipMoveOp[];
  deletes?: string[];
  /** The same kinds of change as a patch: apply_patch format or a unified diff. */
  patch?: string;
  verify?: string | string[];
  timeout_ms?: number;
  rollback_on_fail?: boolean;
  rollback_on_verify_fail?: boolean;
  allow_secrets?: boolean;
}

export interface RestoreOps {
  writeFile: (absPath: string, bytes: Buffer, mode?: number) => void;
  unlink: (absPath: string) => void;
  readFile: (absPath: string) => Buffer;
}

export type ShipStatus =
  | "SHIPPED_AND_VERIFIED"
  | "APPLIED_NO_VERIFY"
  | "ABORTED_BEFORE_WRITE"
  | "FAILED_AND_ROLLED_BACK"
  | "FAILED_ROLLBACK_PARTIAL"
  | "FAILED_KEPT_ON_DISK";

export interface ShipResult {
  status: ShipStatus;
  summary: string;
  filesModified: string[];
  verifyPassed: boolean;
  rollbackErrors: string[];
  elapsedMs: number;
}

interface Preimage {
  relPath: string;
  absPath: string;
  existed: boolean;
  bytes: Buffer;
  sha256: string;
  mode: number | undefined;
}

interface PlannedWrite {
  relPath: string;
  absPath: string;
  /** `null` means the file is deleted. */
  nextBytes: Buffer | null;
  preimage: Preimage;
  /** Permission bits for a file this call creates by moving another one. */
  mode?: number;
  /** Set on the new path of a moved file, and on the old one. */
  movedFrom?: string;
  movedTo?: string;
}

interface TurnpackProjectConfig {
  enforceVerifyAllowlist: boolean;
  allowedVerify: string[];
}

const FAIL_OUTPUT_HEAD_BYTES = 4096;
const FAIL_OUTPUT_TAIL_BYTES = 16384;
const PASS_OUTPUT_TAIL_BYTES = 1500;
/** After the verify command exits, how long to wait for the rest of its output before returning. */
const OUTPUT_DRAIN_MS = 500;
/** After a timeout kill, how long to wait for the command to be reported dead before returning anyway. */
const KILL_GRACE_MS = 2000;
const LEFT_RUNNING_NOTE =
  "\n[turnpack: the command finished but left a background process holding its output open; ship did not wait for it]";
// Characters that let one shell command line carry a second command. Only consulted when the
// project opted into the verify allowlist.
const SHELL_CONTROL = /[;&|<>`$()\r\n]/;
const ANSI_ESCAPES = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * Reads `.turnpack.json` from one directory. A file that exists but cannot be understood is an
 * error, not "no config": silently ignoring a broken allowlist would turn the guardrail off.
 */
function loadProjectConfig(configDir: string): TurnpackProjectConfig {
  const cfgPath = path.join(configDir, ".turnpack.json");
  let text: string;
  try {
    text = fs.readFileSync(cfgPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { enforceVerifyAllowlist: false, allowedVerify: [] };
    }
    throw new Error(`.turnpack.json is unreadable (${err instanceof Error ? err.message : String(err)})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`.turnpack.json is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!isRecord(parsed)) {
    throw new Error(".turnpack.json must contain a JSON object");
  }
  const allowed = parsed.allowedVerify;
  if (allowed !== undefined && (!Array.isArray(allowed) || allowed.some((x) => typeof x !== "string"))) {
    throw new Error(".turnpack.json allowedVerify must be an array of strings");
  }
  return {
    enforceVerifyAllowlist: parsed.enforceVerifyAllowlist === true,
    allowedVerify: ((allowed as string[] | undefined) ?? []).map((s) => s.trim()).filter(Boolean),
  };
}

/**
 * Directories whose `.turnpack.json` governs a call running in `cwd`: `cwd` itself and every
 * parent up to the server's workspace root. The caller picks `cwd`, so looking only there
 * would let it step into a subdirectory to get out from under the root's allowlist.
 */
function configDirsFor(cwd: string, workspaceRoots: string[]): string[] {
  const top = workspaceRoots.find((root) => isInsideDir(root, cwd));
  const dirs = [cwd];
  if (!top) return dirs;
  let cursor = cwd;
  while (cursor !== top && cursor !== path.dirname(cursor)) {
    cursor = path.dirname(cursor);
    dirs.push(cursor);
  }
  return dirs;
}

/**
 * A command passes when it is exactly an allowed entry.
 *
 * Extra arguments are not accepted by default, because arguments change what a command runs
 * (`npm test --prefix other/`, `node --test --import ./x.mjs`). An entry that ends in " *"
 * opts in to trailing arguments for that command. Even then shell control characters are
 * refused, so `npm test && curl … | sh` never rides in on the `npm test` prefix.
 */
export function isVerifyAllowed(command: string, allowed: string[]): boolean {
  return allowed.some((entry) => {
    if (!entry.endsWith(" *")) return command === entry;
    const prefix = entry.slice(0, -2).trimEnd();
    if (!prefix) return false;
    if (command === prefix) return true;
    return command.startsWith(`${prefix} `) && !SHELL_CONTROL.test(command.slice(prefix.length));
  });
}


/** Collects the first and last parts of a stream; test failures are reported at the end. */
class BoundedOutput {
  private readonly head: Buffer[] = [];
  private headBytes = 0;
  private tail: Buffer[] = [];
  private tailBytes = 0;
  private totalBytes = 0;

  constructor(
    private readonly headMax: number,
    private readonly tailMax: number,
  ) {}

  push(chunk: Buffer): void {
    this.totalBytes += chunk.length;
    let rest = chunk;
    if (this.headBytes < this.headMax) {
      const take = rest.subarray(0, this.headMax - this.headBytes);
      this.head.push(take);
      this.headBytes += take.length;
      rest = rest.subarray(take.length);
    }
    if (rest.length === 0) return;
    this.tail.push(rest);
    this.tailBytes += rest.length;
    while (this.tail.length > 1 && this.tailBytes - (this.tail[0]?.length ?? 0) >= this.tailMax) {
      const dropped = this.tail.shift();
      this.tailBytes -= dropped?.length ?? 0;
    }
  }

  text(): string {
    let tailBuf = Buffer.concat(this.tail);
    if (tailBuf.length > this.tailMax) {
      tailBuf = tailBuf.subarray(tailBuf.length - this.tailMax);
    }
    const headText = Buffer.concat(this.head).toString("utf8");
    const tailText = tailBuf.toString("utf8");
    const omitted = this.totalBytes - this.headBytes - tailBuf.length;
    if (omitted <= 0) {
      return (headText + tailText).replace(ANSI_ESCAPES, "").trim();
    }
    // Cut both sides back to whole lines so the gap never splits a character or a colour code.
    const headEnd = headText.lastIndexOf("\n");
    const tailStart = tailText.indexOf("\n");
    const wholeHead = headEnd === -1 ? headText : headText.slice(0, headEnd);
    const wholeTail = tailStart === -1 ? tailText : tailText.slice(tailStart + 1);
    return `${wholeHead}\n[... about ${omitted} bytes of output omitted ...]\n${wholeTail}`
      .replace(ANSI_ESCAPES, "")
      .trim();
  }
}

function tailText(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  const cut = buf.subarray(buf.length - maxBytes).toString("utf8");
  const firstBreak = cut.indexOf("\n");
  return `[... earlier output omitted ...]\n${firstBreak === -1 ? cut : cut.slice(firstBreak + 1)}`;
}

function killProcessTreeSync(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already exited.
    }
  }
}

function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.on("error", () => {
      // taskkill unavailable; nothing more we can do.
    });
    return;
  }
  killProcessTreeSync(pid);
}

interface VerifyRun {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  output: string;
}

function runVerifyCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  onChild: (child: ChildProcess | null) => void,
): Promise<VerifyRun> {
  return new Promise((resolveRun) => {
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
    delete env.FORCE_COLOR;

    const child = spawn(command, {
      cwd,
      env,
      shell: true,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    onChild(child);

    const output = new BoundedOutput(FAIL_OUTPUT_HEAD_BYTES, FAIL_OUTPUT_TAIL_BYTES);
    child.stdout?.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => output.push(chunk));

    let timedOut = false;
    let settled = false;
    let exitCode: number | null = null;
    let drainTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const settle = (run: VerifyRun): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drainTimer);
      clearTimeout(killTimer);
      onChild(null);
      resolveRun(run);
    };
    const finish = (code: number | null, pipesLeftOpen: boolean): void => {
      if (pipesLeftOpen) {
        // Let go of the pipes. Whatever still holds the other end keeps running on its own.
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
      settle({
        ok: !timedOut && code === 0,
        exitCode: code,
        timedOut,
        output: pipesLeftOpen ? `${output.text()}${LEFT_RUNNING_NOTE}` : output.text(),
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killProcessTree(child.pid);
      // The kill reaches the command and what it started, but not a process that detached
      // itself. If one of those keeps the pipes open, stop waiting for it.
      killTimer = setTimeout(() => finish(exitCode, true), KILL_GRACE_MS);
    }, timeoutMs);

    child.on("error", (err) => {
      settle({ ok: false, exitCode: null, timedOut, output: err.message });
    });
    // "exit" is the command finishing; "close" is its output pipes closing. They normally arrive
    // together. They do not when the command leaves a process behind that inherited the pipes
    // (a dev server a test started and never stopped): "close" then waits for that process, which
    // may be forever, and every later ship call queues behind this one. So the verdict is taken
    // at "exit", after a moment for the last of the output.
    child.on("exit", (code) => {
      exitCode = code;
      drainTimer = setTimeout(() => finish(code, true), OUTPUT_DRAIN_MS);
    });
    child.on("close", (code) => finish(code ?? exitCode, false));
  });
}

const DEFAULT_RESTORE_OPS: RestoreOps = {
  writeFile: (absPath, bytes, mode) => {
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, bytes, mode === undefined ? {} : { mode });
  },
  unlink: (absPath) => {
    fs.rmSync(absPath, { force: true });
  },
  readFile: (absPath) => fs.readFileSync(absPath),
};

/** SHA-256 of the file as it is now, null if it does not exist, undefined if that cannot be told. */
function currentSha(absPath: string, ops: RestoreOps): string | null | undefined {
  try {
    return sha256(ops.readFile(absPath));
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined;
  }
}

function restoreSnapshots(plans: PlannedWrite[], createdDirs: string[], ops: RestoreOps): string[] {
  const errors: string[] = [];
  for (let i = plans.length - 1; i >= 0; i--) {
    const plan = plans[i];
    if (!plan) continue;
    const { preimage } = plan;
    try {
      // Restore only what ship itself left there. If the file no longer holds what ship wrote,
      // something else changed it while verify ran (a save in the editor, most likely), and
      // writing the snapshot over it would destroy that change without a word.
      const shipped = plan.nextBytes === null ? null : sha256(plan.nextBytes);
      const current = currentSha(preimage.absPath, ops);
      if (current !== undefined && current !== shipped) {
        if (current === (preimage.existed ? preimage.sha256 : null)) continue; // already as it was
        errors.push(
          `${preimage.relPath}: changed on disk while verify was running, so it was left as it is (not restored)`,
        );
        continue;
      }
      if (preimage.existed) {
        ops.writeFile(preimage.absPath, preimage.bytes, preimage.mode);
        if (sha256(ops.readFile(preimage.absPath)) !== preimage.sha256) {
          errors.push(`${preimage.relPath}: restored checksum mismatch`);
        }
      } else {
        ops.unlink(preimage.absPath);
      }
    } catch (err) {
      errors.push(`${preimage.relPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // Directories this call created come back out, deepest first, and only if nothing else
  // (a build artifact, an editor swap file) has moved in since.
  for (const dir of [...createdDirs].sort((a, b) => b.length - a.length)) {
    try {
      fs.rmdirSync(dir);
    } catch {
      // Not empty or already gone: leave it.
    }
  }
  return errors;
}

/** Ancestor directories of `absPath` that do not exist yet, shallowest first. */
function missingParentDirs(absPath: string, workspaceRoot: string): string[] {
  const missing: string[] = [];
  let cursor = path.dirname(absPath);
  while (cursor !== workspaceRoot && cursor !== path.dirname(cursor) && !fs.existsSync(cursor)) {
    missing.unshift(cursor);
    cursor = path.dirname(cursor);
  }
  return missing;
}

function abort(message: string, t0: number): ShipResult {
  return {
    status: "ABORTED_BEFORE_WRITE",
    summary: `ABORTED_BEFORE_WRITE: ${message}`,
    filesModified: [],
    verifyPassed: false,
    rollbackErrors: [],
    elapsedMs: Math.round(performance.now() - t0),
  };
}

// Argument names, documented one first. Models reach for the names of the edit tools they were
// trained on (`old_string`, `file_path`, `oldText`); reading those costs nothing, and refusing
// them costs a turn.
const PATH_KEYS = ["path", "file_path", "file", "filename", "filepath"] as const;
const SEARCH_KEYS = ["search", "old_string", "old_str", "oldText", "old_text", "old", "find"] as const;
const REPLACE_KEYS = ["replace", "new_string", "new_str", "newText", "new_text", "new", "replacement"] as const;
const REPLACE_ALL_KEYS = ["replace_all", "replaceAll", "all"] as const;
const CONTENT_KEYS = ["content", "contents", "text", "new_content"] as const;
const FROM_KEYS = ["from", "source", "src", "old_path", "path"] as const;
const TO_KEYS = ["to", "destination", "dest", "new_path"] as const;

const EDITS_KEYS = ["edits", "edit"] as const;
const WRITES_KEYS = ["writes", "write"] as const;
const MOVES_KEYS = ["moves", "move", "renames", "rename"] as const;
const DELETES_KEYS = ["deletes", "delete", "remove"] as const;
const VERIFY_KEYS = ["verify", "verify_command", "verify_commands"] as const;
const PATCH_KEYS = ["patch", "diff"] as const;
const KNOWN_SHIP_KEYS: readonly string[] = [
  ...ROOT_KEYS,
  ...EDITS_KEYS,
  ...WRITES_KEYS,
  ...MOVES_KEYS,
  ...DELETES_KEYS,
  ...VERIFY_KEYS,
  ...PATCH_KEYS,
  "timeout_ms",
  "rollback_on_fail",
  "rollback_on_verify_fail",
  "allow_secrets",
];

function parseChange(value: unknown, label: string): ShipEditChange {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object with search and replace`);
  }
  const search = pick(value, SEARCH_KEYS);
  const replace = pick(value, REPLACE_KEYS);
  if (typeof search !== "string" || typeof replace !== "string") {
    throw new Error(
      `${label} needs a search string and a replace string` +
        (typeof pick(value, CONTENT_KEYS) === "string" ? " (to replace a whole file, put it in writes)" : ""),
    );
  }
  return {
    search,
    replace,
    replace_all: optionalBoolean(pick(value, REPLACE_ALL_KEYS), `${label}.replace_all`),
  };
}


/** True when two paths are one file, as on a case-insensitive file system. */
function sameFile(a: string, b: string): boolean {
  try {
    const left = fs.statSync(a);
    const right = fs.statSync(b);
    return left.ino !== 0 && left.ino === right.ino && left.dev === right.dev;
  } catch {
    return false;
  }
}

const ROLLBACK_SIGNALS: NodeJS.Signals[] =
  process.platform === "win32" ? ["SIGINT", "SIGTERM", "SIGBREAK"] : ["SIGINT", "SIGTERM", "SIGHUP"];

export interface ShipInternalOptions {
  restoreOps?: RestoreOps;
  /**
   * The server's workspace roots. When given, a `.turnpack.json` anywhere between `cwd` and the
   * root that contains it is enforced, not just one in `cwd`.
   */
  workspaceRoots?: string[];
  /** Told what ship is doing while it waits on a verify command. */
  onProgress?: (message: string) => void;
}

export async function runShip(
  args: ShipArgs,
  internalOpts: ShipInternalOptions = {},
): Promise<ShipResult> {
  const t0 = performance.now();
  const restoreOps = internalOpts.restoreOps ?? DEFAULT_RESTORE_OPS;
  const raw: Record<string, unknown> = isRecord(args) ? args : {};

  let workspaceRoot: string;
  let allowSecrets: boolean;
  let shouldRollback: boolean;
  let timeoutMs: number;
  let verifyList: string[];
  let writeOps: unknown[];
  let editOps: unknown[];
  let moveOps: unknown[];
  let deleteOps: unknown[];
  let patchText: string | undefined;
  try {
    // An argument ship does not know, carrying a list or a long string, is part of the change
    // the model asked for. Ignoring it would ship the rest and report success.
    const stray = unknownWorkKeys(raw, KNOWN_SHIP_KEYS);
    if (stray.length > 0) {
      throw new Error(
        `unknown argument${stray.length > 1 ? "s" : ""} ${stray.map((key) => `"${key}"`).join(", ")}. ` +
          "ship takes edits [{path, search, replace}] or a patch, writes [{path, content}], moves [{from, to}], deletes [path] and verify [command]. Nothing was written.",
      );
    }
    workspaceRoot = resolveWorkspaceRoot(optionalString(pick(raw, ROOT_KEYS), "ship.root"));
    allowSecrets = optionalBoolean(raw.allow_secrets, "ship.allow_secrets") ?? false;
    shouldRollback =
      optionalBoolean(raw.rollback_on_fail, "ship.rollback_on_fail") ??
      optionalBoolean(raw.rollback_on_verify_fail, "ship.rollback_on_verify_fail") ??
      true;
    timeoutMs = Math.min(
      300000,
      Math.max(1000, Math.trunc(optionalNumber(raw.timeout_ms, "ship.timeout_ms") ?? 60000)),
    );
    verifyList = optionalStringList(unwrapJson(pick(raw, VERIFY_KEYS)), "ship.verify")
      .map((s) => s.trim())
      .filter(Boolean);
    writeOps = optionalList(unwrapJson(pick(raw, WRITES_KEYS)), "ship.writes");
    editOps = optionalList(unwrapJson(pick(raw, EDITS_KEYS)), "ship.edits");
    moveOps = optionalList(unwrapJson(pick(raw, MOVES_KEYS)), "ship.moves");
    deleteOps = optionalList(unwrapJson(pick(raw, DELETES_KEYS)), "ship.deletes");
    patchText = optionalString(pick(raw, PATCH_KEYS), "ship.patch");
  } catch (err) {
    return abort(err instanceof Error ? err.message : String(err), t0);
  }

  // Phase 1: decide whether the verify commands may run at all, before touching anything.
  if (verifyList.length > 0) {
    for (const configDir of configDirsFor(workspaceRoot, internalOpts.workspaceRoots ?? [])) {
      let cfg: TurnpackProjectConfig;
      try {
        cfg = loadProjectConfig(configDir);
      } catch (err) {
        return abort(err instanceof Error ? err.message : String(err), t0);
      }
      if (!cfg.enforceVerifyAllowlist) continue;
      for (const cmd of verifyList) {
        if (!isVerifyAllowed(cmd, cfg.allowedVerify)) {
          return abort(
            `verify command "${cmd}" is not in .turnpack.json allowedVerify list (allowed: ${cfg.allowedVerify.join(" | ") || "none"}; a command must match an entry exactly, unless the entry ends in " *")`,
            t0,
          );
        }
      }
    }
  }

  // Phase 2: validate every operation in memory and snapshot preimages. Nothing is written yet,
  // so any problem here leaves the workspace exactly as it was. Every operation is checked even
  // after one fails, so a single reply lists everything that needs fixing.
  const plansByRel = new Map<string, PlannedWrite>();
  const problems: string[] = [];
  const lenient: string[] = [];
  const attempt = (run: () => void): void => {
    try {
      run();
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err));
    }
  };

  const guardPath = (target: string, action: string): { absPath: string; relPath: string } => {
    const safe = resolveSafePath(workspaceRoot, target);
    if (safe.relPath === ".") {
      throw new Error(`${action} target "${target}" is the workspace root, not a file`);
    }
    // Checked on the absolute path: the caller picks cwd, and could pick ".git" itself.
    if (isProtectedPath(safe.absPath)) {
      throw new Error(
        `"${safe.relPath}" is protected: ship never modifies a .turnpack.json or anything inside a .git directory`,
      );
    }
    if (!allowSecrets && isSecretPath(safe.relPath, workspaceRoot)) {
      throw new Error(
        `Secret file ${action} blocked for "${safe.relPath}" (pass allow_secrets: true to override)`,
      );
    }
    return safe;
  };

  const snapshot = (safe: { absPath: string; relPath: string }): Preimage => {
    // lstat: the resolved path must be the file itself. If it is still a link here, something
    // changed between resolving and snapshotting, and writing would follow it somewhere unchecked.
    let stat: fs.Stats | null = null;
    try {
      stat = fs.lstatSync(safe.absPath);
    } catch {
      stat = null;
    }
    if (stat?.isSymbolicLink()) {
      throw new Error(`"${safe.relPath}" resolves to a symbolic link; ship does not write through links`);
    }
    if (stat && !stat.isFile()) {
      throw new Error(`"${safe.relPath}" exists but is not a regular file`);
    }
    const bytes = stat ? fs.readFileSync(safe.absPath) : Buffer.alloc(0);
    return {
      relPath: safe.relPath,
      absPath: safe.absPath,
      existed: stat !== null,
      bytes,
      sha256: stat ? sha256(bytes) : "",
      mode: stat ? stat.mode & 0o7777 : undefined,
    };
  };

  const notFound = (what: string, relPath: string): Error =>
    new Error(`${what} not found: "${relPath}".${suggestPaths(workspaceRoot, relPath)}`);

  // Moves come first, so the same call can go on to edit a file under its new name.
  moveOps.forEach((item, idx) =>
    attempt(() => {
      if (!isRecord(item)) throw new Error(`ship.moves[${idx}] must be an object with from and to`);
      const source = guardPath(requiredString(pick(item, FROM_KEYS), `ship.moves[${idx}].from`), "move");
      const target = guardPath(requiredString(pick(item, TO_KEYS), `ship.moves[${idx}].to`), "move");
      if (plansByRel.has(source.relPath) || plansByRel.has(target.relPath)) {
        throw new Error(`"${source.relPath}" or "${target.relPath}" is moved twice in the same call`);
      }
      const sourceImage = snapshot(source);
      if (!sourceImage.existed) throw notFound("Move source", source.relPath);
      const targetImage = snapshot(target);
      if (targetImage.existed) {
        throw new Error(
          sameFile(source.absPath, target.absPath)
            ? `"${source.relPath}" and "${target.relPath}" are one file on this file system; ship does not do renames that change only the letter case`
            : `Move target already exists: "${target.relPath}"`,
        );
      }
      plansByRel.set(source.relPath, { ...source, nextBytes: null, preimage: sourceImage, movedTo: target.relPath });
      plansByRel.set(target.relPath, {
        ...target,
        nextBytes: sourceImage.bytes,
        preimage: targetImage,
        mode: sourceImage.mode,
        movedFrom: source.relPath,
      });
    }),
  );

  // A patch is the same kinds of change in another notation, so it goes through the same plan:
  // checked in full before anything is written, tested, and undone if the test fails.
  if (patchText?.trim()) {
    let patchFiles: PatchFile[] = [];
    attempt(() => {
      patchFiles = parsePatch(patchText as string);
    });
    for (const entry of patchFiles) {
      attempt(() => {
        if (entry.kind === "add") {
          const safe = guardPath(entry.path, "write");
          const earlier = plansByRel.get(safe.relPath);
          if (earlier?.movedTo) {
            throw new Error(`"${safe.relPath}" is moved to "${earlier.movedTo}" by this call; write to the new path`);
          }
          plansByRel.set(safe.relPath, {
            ...safe,
            nextBytes: Buffer.from(entry.content ?? "", "utf8"),
            preimage: earlier?.preimage ?? snapshot(safe),
            mode: earlier?.mode,
            movedFrom: earlier?.movedFrom,
          });
          return;
        }
        if (entry.kind === "delete") {
          const safe = guardPath(entry.path, "delete");
          if (plansByRel.has(safe.relPath)) {
            throw new Error(`"${safe.relPath}" is both written/edited and deleted in the same call`);
          }
          const preimage = snapshot(safe);
          if (!preimage.existed) throw notFound("Delete target", safe.relPath);
          plansByRel.set(safe.relPath, { ...safe, nextBytes: null, preimage });
          return;
        }

        const safe = guardPath(entry.path, "edit");
        const earlier = plansByRel.get(safe.relPath);
        if (earlier?.movedTo) {
          throw new Error(`"${safe.relPath}" is moved to "${earlier.movedTo}" by this call; patch it under its new path`);
        }
        if (earlier && earlier.nextBytes === null) {
          throw new Error(`"${safe.relPath}" is both edited and deleted in the same call`);
        }
        const preimage = earlier?.preimage ?? snapshot(safe);
        if (!earlier && !preimage.existed) throw notFound("Patch target", safe.relPath);
        const bytes = earlier?.nextBytes ?? preimage.bytes;
        const text = bytes.toString("utf8");
        if (!Buffer.from(text, "utf8").equals(bytes)) {
          throw new Error(`"${safe.relPath}" is not valid UTF-8 text, so it cannot be patched (use writes to replace the whole file)`);
        }
        const applied = applyHunks(text, entry.hunks);
        if (!applied.ok) throw new Error(`${safe.relPath} (patch): ${applied.message}`);
        for (const note of applied.notes) lenient.push(`${safe.relPath} (patch): ${note}`);
        const nextBytes = Buffer.from(applied.text, "utf8");

        const target = entry.moveTo ? guardPath(entry.moveTo, "move") : safe;
        if (target.relPath === safe.relPath) {
          plansByRel.set(safe.relPath, { ...safe, nextBytes, preimage, mode: earlier?.mode, movedFrom: earlier?.movedFrom });
          return;
        }
        if (plansByRel.has(target.relPath)) {
          throw new Error(`"${target.relPath}" is already changed by this call`);
        }
        const targetImage = snapshot(target);
        if (targetImage.existed) {
          throw new Error(
            sameFile(safe.absPath, target.absPath)
              ? `"${safe.relPath}" and "${target.relPath}" are one file on this file system; ship does not do renames that change only the letter case`
              : `Move target already exists: "${target.relPath}"`,
          );
        }
        plansByRel.set(safe.relPath, { ...safe, nextBytes: null, preimage, movedTo: target.relPath });
        plansByRel.set(target.relPath, {
          ...target,
          nextBytes,
          preimage: targetImage,
          mode: preimage.mode,
          movedFrom: safe.relPath,
        });
      });
    }
  }

  writeOps.forEach((item, idx) =>
    attempt(() => {
      if (!isRecord(item)) throw new Error(`ship.writes[${idx}] must be an object with path and content`);
      const target = requiredString(pick(item, PATH_KEYS), `ship.writes[${idx}].path`);
      const content = pick(item, CONTENT_KEYS);
      if (typeof content !== "string") {
        throw new Error(`ship.writes[${idx}].content must be a string`);
      }
      const expectedSha = optionalString(item.expected_sha256, `ship.writes[${idx}].expected_sha256`);
      const safe = guardPath(target, "write");
      const earlier = plansByRel.get(safe.relPath);
      if (earlier?.movedTo) {
        throw new Error(`"${safe.relPath}" is moved to "${earlier.movedTo}" by this call; write to the new path`);
      }
      const preimage = earlier?.preimage ?? snapshot(safe);
      if (expectedSha && preimage.existed && preimage.sha256 !== expectedSha.toLowerCase()) {
        throw new Error(`Precondition failed for "${safe.relPath}": SHA-256 changed on disk`);
      }
      plansByRel.set(safe.relPath, {
        ...safe,
        nextBytes: Buffer.from(content, "utf8"),
        preimage,
        mode: earlier?.mode,
        movedFrom: earlier?.movedFrom,
      });
    }),
  );

  editOps.forEach((item, idx) =>
    attempt(() => {
      if (!isRecord(item)) throw new Error(`ship.edits[${idx}] must be an object with path, search and replace`);
      const target = requiredString(pick(item, PATH_KEYS), `ship.edits[${idx}].path`);
      const safe = guardPath(target, "edit");
      const earlier = plansByRel.get(safe.relPath);

      let preimage: Preimage;
      let workingBytes: Buffer;
      if (earlier) {
        if (earlier.movedTo) {
          throw new Error(
            `"${safe.relPath}" is moved to "${earlier.movedTo}" by this call; edit it under its new path`,
          );
        }
        if (earlier.nextBytes === null) {
          throw new Error(`"${safe.relPath}" is both edited and deleted in the same call`);
        }
        preimage = earlier.preimage;
        workingBytes = earlier.nextBytes;
      } else {
        preimage = snapshot(safe);
        if (!preimage.existed) throw notFound("Edit target", safe.relPath);
        const expectedSha = optionalString(item.expected_sha256, `ship.edits[${idx}].expected_sha256`);
        if (expectedSha && preimage.sha256 !== expectedSha.toLowerCase()) {
          throw new Error(`Precondition failed for "${safe.relPath}": SHA-256 changed on disk`);
        }
        const expectedMtime = optionalNumber(item.expected_mtime_ms, `ship.edits[${idx}].expected_mtime_ms`);
        if (
          expectedMtime !== undefined &&
          Math.abs(fs.statSync(safe.absPath).mtimeMs - expectedMtime) > 5
        ) {
          throw new Error(`Precondition failed for "${safe.relPath}": mtime changed on disk`);
        }
        workingBytes = preimage.bytes;
      }
      // Search/replace goes through a string. A file that is not valid UTF-8 would not survive
      // that round trip intact, so refuse rather than corrupt bytes the edit never mentioned.
      let workingText = workingBytes.toString("utf8");
      if (!Buffer.from(workingText, "utf8").equals(workingBytes)) {
        throw new Error(
          `"${safe.relPath}" is not valid UTF-8 text, so search/replace edits are refused (use writes to replace the whole file)`,
        );
      }

      const nested = optionalList(unwrapJson(pick(item, ["changes", "edits"])), `ship.edits[${idx}].changes`);
      const changes: ShipEditChange[] =
        nested.length > 0
          ? nested.map((ch, j) => parseChange(ch, `ship.edits[${idx}].changes[${j}]`))
          : pick(item, SEARCH_KEYS) !== undefined || pick(item, REPLACE_KEYS) !== undefined
            ? [parseChange(item, `ship.edits[${idx}]`)]
            : [];
      if (changes.length === 0) {
        throw new Error(
          `ship.edits[${idx}] for "${safe.relPath}" needs search and replace, or a changes list` +
            (typeof pick(item, CONTENT_KEYS) === "string" ? " (to replace the whole file, put it in writes)" : ""),
        );
      }

      changes.forEach((change, j) => {
        const where =
          changes.length > 1 ? `${safe.relPath} (edits[${idx}].changes[${j}])` : `${safe.relPath} (edits[${idx}])`;
        const outcome = applySearchReplace(workingText, change.search, change.replace, change.replace_all === true);
        if (!outcome.ok) {
          problems.push(`${where}: ${outcome.message}`);
          return;
        }
        workingText = outcome.text;
        if (outcome.how !== "exact" && outcome.how !== "line-endings") {
          lenient.push(`${where}: matched by ignoring ${HOW_LABEL[outcome.how]}`);
        }
      });

      plansByRel.set(safe.relPath, {
        ...safe,
        nextBytes: Buffer.from(workingText, "utf8"),
        preimage,
        mode: earlier?.mode,
        movedFrom: earlier?.movedFrom,
      });
    }),
  );

  deleteOps.forEach((item, idx) =>
    attempt(() => {
      const target = typeof item === "string" ? item : isRecord(item) ? pick(item, PATH_KEYS) : undefined;
      if (typeof target !== "string" || !target) {
        throw new Error(`ship.deletes[${idx}] must be a file path`);
      }
      const safe = guardPath(target, "delete");
      if (plansByRel.has(safe.relPath)) {
        throw new Error(`"${safe.relPath}" is both written/edited and deleted in the same call`);
      }
      const preimage = snapshot(safe);
      if (!preimage.existed) throw notFound("Delete target", safe.relPath);
      plansByRel.set(safe.relPath, { ...safe, nextBytes: null, preimage });
    }),
  );

  if (problems.length === 1) {
    return abort(`${problems[0]}\n\nNothing was written.`, t0);
  }
  if (problems.length > 1) {
    return abort(
      [
        `${problems.length} problems, nothing was written.`,
        ...problems.map((problem, i) => `${i + 1}. ${problem}`),
        "Fix these and send the whole call again.",
      ].join("\n\n"),
      t0,
    );
  }

  const plans = [...plansByRel.values()];
  if (plans.length === 0 && verifyList.length === 0) {
    return abort("provide at least one write, edit, move, delete, or verify command", t0);
  }

  const describe = (plan: PlannedWrite): string =>
    plan.nextBytes === null
      ? `${plan.relPath} (deleted)`
      : plan.movedFrom
        ? `${plan.relPath} (moved from ${plan.movedFrom})`
        : plan.preimage.existed
          ? plan.relPath
          : `${plan.relPath} (new)`;
  const fileList = plans.map((p) => p.relPath);
  // A move is one change: it is listed once, under its new name.
  const listed = plans.filter((plan) => !plan.movedTo);
  const changedCount = listed.length;
  const fileSummary = listed.map(describe).join(", ");
  // Said whenever the edits reached the disk or were tried: the model's picture of those files
  // was slightly off, and it should know before it writes the next edit from the same picture.
  const lenientNote =
    lenient.length > 0
      ? [
          `Note: ${lenient.length} search text(s) did not match the file exactly. Each identified one place without ambiguity, so it was applied there:\n  - ${lenient.join("\n  - ")}`,
        ]
      : [];

  // From here on the workspace is modified. If the process is asked to stop while edits are
  // unverified, put the files back first instead of leaving a half-shipped tree behind.
  const createdDirs: string[] = [];
  let activeChild: ChildProcess | null = null;
  let restored = false;
  const restoreOnce = (): string[] => {
    if (restored) return [];
    restored = true;
    return restoreSnapshots(plans, createdDirs, restoreOps);
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    if (activeChild?.pid) killProcessTreeSync(activeChild.pid);
    if (shouldRollback && verifyList.length > 0) {
      const errors = restoreOnce();
      process.stderr.write(
        `turnpack: ${signal} during ship; ${errors.length === 0 ? `restored ${plans.length} file(s)` : `rollback errors: ${errors.join("; ")}`}\n`,
      );
    }
    removeSignalHandlers();
    process.kill(process.pid, signal);
  };
  const removeSignalHandlers = (): void => {
    for (const sig of ROLLBACK_SIGNALS) process.removeListener(sig, onSignal);
  };
  for (const sig of ROLLBACK_SIGNALS) process.on(sig, onSignal);

  try {
    // Phase 3: write.
    const writtenSoFar: PlannedWrite[] = [];
    try {
      for (const plan of plans) {
        // Checked again at the moment of writing, in case the path was swapped for a link
        // after it was validated.
        if (fs.lstatSync(plan.absPath, { throwIfNoEntry: false })?.isSymbolicLink()) {
          throw new Error(`"${plan.relPath}" became a symbolic link during the call`);
        }
        if (plan.nextBytes === null) {
          fs.unlinkSync(plan.absPath);
        } else {
          const newDirs = missingParentDirs(plan.absPath, workspaceRoot);
          fs.mkdirSync(path.dirname(plan.absPath), { recursive: true });
          createdDirs.push(...newDirs);
          fs.writeFileSync(plan.absPath, plan.nextBytes, plan.mode === undefined ? {} : { mode: plan.mode });
        }
        writtenSoFar.push(plan);
      }
    } catch (err) {
      restored = true;
      const rbErrors = restoreSnapshots(writtenSoFar, createdDirs, restoreOps);
      const status: ShipStatus = rbErrors.length > 0 ? "FAILED_ROLLBACK_PARTIAL" : "FAILED_AND_ROLLED_BACK";
      return {
        status,
        summary:
          `${status}: write failed (${err instanceof Error ? err.message : String(err)}). ` +
          (rbErrors.length === 0
            ? `Restored ${writtenSoFar.length} already-written file(s).`
            : `Rollback Errors (${rbErrors.length}):\n  - ${rbErrors.join("\n  - ")}`),
        filesModified: rbErrors.length === 0 ? [] : writtenSoFar.map((p) => p.relPath),
        verifyPassed: false,
        rollbackErrors: rbErrors,
        elapsedMs: Math.round(performance.now() - t0),
      };
    }

    if (verifyList.length === 0) {
      // The one thing that makes ship worth calling was left out. If the project says what its
      // check is, name it, so the next call can use it.
      const checks = describeChecks(detectChecks(workspaceRoot));
      return {
        status: "APPLIED_NO_VERIFY",
        summary: [
          `APPLIED_NO_VERIFY: ${changedCount} file(s) changed (${fileSummary}). No verify command was given, so nothing was tested.` +
            (checks ? ` ${checks} Pass it as verify and a change that fails it is undone for you.` : ""),
          ...lenientNote,
        ].join("\n\n"),
        filesModified: fileList,
        verifyPassed: false,
        rollbackErrors: [],
        elapsedMs: Math.round(performance.now() - t0),
      };
    }

    // Phase 4: verify, one command at a time, stopping at the first failure.
    const passedOutputs: string[] = [];
    for (const cmd of verifyList) {
      internalOpts.onProgress?.(`running ${cmd}`);
      const run = await runVerifyCommand(cmd, workspaceRoot, timeoutMs, (child) => {
        activeChild = child;
      });
      if (run.ok) {
        passedOutputs.push(`$ ${cmd}  (passed)\n${tailText(run.output, PASS_OUTPUT_TAIL_BYTES) || "(no output)"}`);
        continue;
      }

      const reason = run.timedOut
        ? `timed out after ${timeoutMs}ms; pass timeout_ms, up to 300000, if this check needs longer`
        : run.exitCode === null
          ? "could not be started"
          : `exit code ${run.exitCode}`;
      const failedOutput = `$ ${cmd}\n${run.output || "(no output)"}`;

      if (!shouldRollback) {
        return {
          status: "FAILED_KEPT_ON_DISK",
          summary: [
            `FAILED_KEPT_ON_DISK: verify "${cmd}" failed (${reason}). Changes kept on disk because rollback_on_fail=false: ${fileSummary || "none"}.`,
            ...lenientNote,
            failedOutput,
          ].join("\n\n"),
          filesModified: fileList,
          verifyPassed: false,
          rollbackErrors: [],
          elapsedMs: Math.round(performance.now() - t0),
        };
      }

      const rollbackErrors = restoreOnce();
      const status: ShipStatus =
        rollbackErrors.length > 0 ? "FAILED_ROLLBACK_PARTIAL" : "FAILED_AND_ROLLED_BACK";
      return {
        status,
        summary: [
          `${status}: verify "${cmd}" failed (${reason}).`,
          rollbackErrors.length === 0
            ? `Restored ${plans.length} file(s) to byte-exact pre-edit snapshots. The workspace is unchanged; fix the edit and ship again.`
            : `Restored ${plans.length - rollbackErrors.length} of ${plans.length} file(s). Rollback Errors (${rollbackErrors.length}):\n  - ${rollbackErrors.join("\n  - ")}\nThose files are not in their pre-edit state. Read them before shipping again.`,
          ...lenientNote,
          failedOutput,
        ].join("\n\n"),
        filesModified: rollbackErrors.length === 0 ? [] : fileList,
        verifyPassed: false,
        rollbackErrors,
        elapsedMs: Math.round(performance.now() - t0),
      };
    }

    const elapsedMs = Math.round(performance.now() - t0);
    return {
      status: "SHIPPED_AND_VERIFIED",
      summary: [
        `SHIPPED_AND_VERIFIED in ${elapsedMs}ms: ${changedCount} file(s) changed (${fileSummary || "verify-only"}).`,
        ...lenientNote,
        ...passedOutputs,
      ].join("\n\n"),
      filesModified: fileList,
      verifyPassed: true,
      rollbackErrors: [],
      elapsedMs,
    };
  } finally {
    removeSignalHandlers();
  }
}
