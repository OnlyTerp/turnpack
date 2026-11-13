import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  isProtectedPath,
  isSecretPath,
  resolveSafePath,
  resolveWorkspaceRoot,
} from "../security.js";
import {
  isRecord,
  optionalBoolean,
  optionalList,
  optionalNumber,
  optionalString,
  optionalStringList,
  requiredString,
} from "../validate.js";

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

export interface ShipArgs {
  cwd?: string;
  writes?: ShipWriteOp[];
  edits?: ShipEditOp[];
  deletes?: string[];
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
}

interface TurnpackProjectConfig {
  enforceVerifyAllowlist: boolean;
  allowedVerify: string[];
}

const FAIL_OUTPUT_HEAD_BYTES = 4096;
const FAIL_OUTPUT_TAIL_BYTES = 16384;
const PASS_OUTPUT_TAIL_BYTES = 1500;
// Characters that let one shell command line carry a second command. Only consulted when the
// project opted into the verify allowlist.
const SHELL_CONTROL = /[;&|<>`$()\r\n]/;
const ANSI_ESCAPES = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * Reads `.turnpack.json`. A file that exists but cannot be understood is an error, not "no
 * config": silently ignoring a broken allowlist would turn the guardrail off.
 */
function loadProjectConfig(workspaceRoot: string): TurnpackProjectConfig {
  const cfgPath = path.join(workspaceRoot, ".turnpack.json");
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
 * A command passes when it is exactly an allowed entry, or an allowed entry followed by plain
 * arguments. "Plain" excludes shell control characters, so `npm test && curl … | sh` does not
 * ride in on the `npm test` prefix.
 */
export function isVerifyAllowed(command: string, allowed: string[]): boolean {
  return allowed.some((entry) => {
    if (command === entry) return true;
    if (!command.startsWith(`${entry} `)) return false;
    return !SHELL_CONTROL.test(command.slice(entry.length));
  });
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

/** Literal replacement: no regex, and no `$&`-style expansion of the replacement text. */
function replaceLiteral(haystack: string, needle: string, replacement: string): string {
  return haystack.split(needle).join(replacement);
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
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killProcessTree(child.pid);
    }, timeoutMs);

    const settle = (run: VerifyRun): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      onChild(null);
      resolveRun(run);
    };

    child.on("error", (err) => {
      settle({ ok: false, exitCode: null, timedOut, output: err.message });
    });
    child.on("close", (code) => {
      settle({ ok: !timedOut && code === 0, exitCode: code, timedOut, output: output.text() });
    });
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

function restoreSnapshots(plans: PlannedWrite[], createdDirs: string[], ops: RestoreOps): string[] {
  const errors: string[] = [];
  for (let i = plans.length - 1; i >= 0; i--) {
    const plan = plans[i];
    if (!plan) continue;
    const { preimage } = plan;
    try {
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

function parseChange(value: unknown, label: string): ShipEditChange {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object with search and replace`);
  }
  if (typeof value.search !== "string" || typeof value.replace !== "string") {
    throw new Error(`${label} requires string search and replace`);
  }
  return {
    search: value.search,
    replace: value.replace,
    replace_all: optionalBoolean(value.replace_all, `${label}.replace_all`),
  };
}

/**
 * Applies one search/replace to `text`. The anchor must match exactly once unless replace_all
 * is set. If it does not match as written and the only difference is line endings (the model
 * wrote "\n", the file uses "\r\n", or the reverse), the anchor is retried with the file's own
 * line endings so edits to CRLF files do not fail on an invisible character.
 */
function applyChange(text: string, change: ShipEditChange, relPath: string): string {
  if (!change.search) {
    throw new Error(`Empty search anchor in edit for "${relPath}"`);
  }
  let search = change.search;
  let replace = change.replace;
  let count = countOccurrences(text, search);

  if (count === 0 && search.includes("\n")) {
    const fileUsesCrlf = text.includes("\r\n");
    const toFileEol = (s: string): string => {
      const lf = s.replace(/\r\n/g, "\n");
      return fileUsesCrlf ? lf.replace(/\n/g, "\r\n") : lf;
    };
    const altSearch = toFileEol(search);
    if (altSearch !== search) {
      const altCount = countOccurrences(text, altSearch);
      if (altCount > 0) {
        search = altSearch;
        replace = toFileEol(replace);
        count = altCount;
      }
    }
  }

  if (count === 0) {
    throw new Error(
      `Anchor not found in "${relPath}": ${JSON.stringify(change.search.slice(0, 80))} (search must match the file exactly, including whitespace)`,
    );
  }
  if (count > 1 && !change.replace_all) {
    throw new Error(
      `Ambiguous anchor in "${relPath}" matched ${count} times (pass replace_all: true or add surrounding context)`,
    );
  }
  return replaceLiteral(text, search, replace);
}

const ROLLBACK_SIGNALS: NodeJS.Signals[] =
  process.platform === "win32" ? ["SIGINT", "SIGTERM", "SIGBREAK"] : ["SIGINT", "SIGTERM", "SIGHUP"];

export async function runShip(
  args: ShipArgs,
  internalOpts: { restoreOps?: RestoreOps } = {},
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
  let deleteOps: string[];
  try {
    workspaceRoot = resolveWorkspaceRoot(optionalString(raw.cwd, "ship.cwd"));
    allowSecrets = optionalBoolean(raw.allow_secrets, "ship.allow_secrets") ?? false;
    shouldRollback =
      optionalBoolean(raw.rollback_on_fail, "ship.rollback_on_fail") ??
      optionalBoolean(raw.rollback_on_verify_fail, "ship.rollback_on_verify_fail") ??
      true;
    timeoutMs = Math.min(
      300000,
      Math.max(1000, Math.trunc(optionalNumber(raw.timeout_ms, "ship.timeout_ms") ?? 60000)),
    );
    verifyList = optionalStringList(raw.verify, "ship.verify").map((s) => s.trim()).filter(Boolean);
    writeOps = optionalList(raw.writes, "ship.writes");
    editOps = optionalList(raw.edits, "ship.edits");
    deleteOps = optionalStringList(raw.deletes, "ship.deletes");
  } catch (err) {
    return abort(err instanceof Error ? err.message : String(err), t0);
  }

  // Phase 1: decide whether the verify commands may run at all, before touching anything.
  if (verifyList.length > 0) {
    let cfg: TurnpackProjectConfig;
    try {
      cfg = loadProjectConfig(workspaceRoot);
    } catch (err) {
      return abort(err instanceof Error ? err.message : String(err), t0);
    }
    if (cfg.enforceVerifyAllowlist) {
      for (const cmd of verifyList) {
        if (!isVerifyAllowed(cmd, cfg.allowedVerify)) {
          return abort(
            `verify command "${cmd}" is not in .turnpack.json allowedVerify list (allowed: ${cfg.allowedVerify.join(" | ") || "none"}; an allowed command may take plain arguments but no shell operators)`,
            t0,
          );
        }
      }
    }
  }

  // Phase 2: validate every operation in memory and snapshot preimages. Nothing is written yet,
  // so any problem here leaves the workspace exactly as it was.
  const plansByRel = new Map<string, PlannedWrite>();

  const guardPath = (target: string, action: string): { absPath: string; relPath: string } => {
    const safe = resolveSafePath(workspaceRoot, target);
    if (safe.relPath === ".") {
      throw new Error(`${action} target "${target}" is the workspace root, not a file`);
    }
    if (isProtectedPath(safe.relPath)) {
      throw new Error(
        `"${safe.relPath}" is protected: ship never modifies .turnpack.json or anything inside .git/`,
      );
    }
    if (!allowSecrets && isSecretPath(safe.relPath)) {
      throw new Error(
        `Secret file ${action} blocked for "${safe.relPath}" (pass allow_secrets: true to override)`,
      );
    }
    return safe;
  };

  const snapshot = (safe: { absPath: string; relPath: string }): Preimage => {
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(safe.absPath);
    } catch {
      stat = null;
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

  try {
    writeOps.forEach((item, idx) => {
      if (!isRecord(item)) throw new Error(`ship.writes[${idx}] must be an object`);
      const target = requiredString(item.path, `ship.writes[${idx}].path`);
      if (typeof item.content !== "string") {
        throw new Error(`ship.writes[${idx}].content must be a string`);
      }
      const expectedSha = optionalString(item.expected_sha256, `ship.writes[${idx}].expected_sha256`);
      const safe = guardPath(target, "write");
      const preimage = plansByRel.get(safe.relPath)?.preimage ?? snapshot(safe);
      if (expectedSha && preimage.existed && preimage.sha256 !== expectedSha.toLowerCase()) {
        throw new Error(`Precondition failed for "${safe.relPath}": SHA-256 changed on disk`);
      }
      plansByRel.set(safe.relPath, {
        relPath: safe.relPath,
        absPath: safe.absPath,
        nextBytes: Buffer.from(item.content, "utf8"),
        preimage,
      });
    });

    editOps.forEach((item, idx) => {
      if (!isRecord(item)) throw new Error(`ship.edits[${idx}] must be an object`);
      const target = requiredString(item.path, `ship.edits[${idx}].path`);
      const safe = guardPath(target, "edit");
      const existingPlan = plansByRel.get(safe.relPath);

      let preimage: Preimage;
      let workingText: string;
      if (existingPlan) {
        if (existingPlan.nextBytes === null) {
          throw new Error(`"${safe.relPath}" is both edited and deleted in the same call`);
        }
        preimage = existingPlan.preimage;
        workingText = existingPlan.nextBytes.toString("utf8");
      } else {
        preimage = snapshot(safe);
        if (!preimage.existed) {
          throw new Error(`Edit target not found: "${safe.relPath}"`);
        }
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
        workingText = preimage.bytes.toString("utf8");
        // Search/replace goes through a string. A file that is not valid UTF-8 would not survive
        // that round trip intact, so refuse rather than corrupt bytes the edit never mentioned.
        if (!Buffer.from(workingText, "utf8").equals(preimage.bytes)) {
          throw new Error(
            `"${safe.relPath}" is not valid UTF-8 text, so search/replace edits are refused (use writes to replace the whole file)`,
          );
        }
      }

      const changeList = optionalList(item.changes, `ship.edits[${idx}].changes`);
      const changes: ShipEditChange[] =
        changeList.length > 0
          ? changeList.map((ch, j) => parseChange(ch, `ship.edits[${idx}].changes[${j}]`))
          : item.search !== undefined || item.replace !== undefined
            ? [parseChange(item, `ship.edits[${idx}]`)]
            : [];
      if (changes.length === 0) {
        throw new Error(`Edit for "${safe.relPath}" requires search+replace or changes[]`);
      }
      for (const change of changes) {
        workingText = applyChange(workingText, change, safe.relPath);
      }

      plansByRel.set(safe.relPath, {
        relPath: safe.relPath,
        absPath: safe.absPath,
        nextBytes: Buffer.from(workingText, "utf8"),
        preimage,
      });
    });

    for (const target of deleteOps) {
      const safe = guardPath(target, "delete");
      if (plansByRel.has(safe.relPath)) {
        throw new Error(`"${safe.relPath}" is both written/edited and deleted in the same call`);
      }
      const preimage = snapshot(safe);
      if (!preimage.existed) {
        throw new Error(`Delete target not found: "${safe.relPath}"`);
      }
      plansByRel.set(safe.relPath, {
        relPath: safe.relPath,
        absPath: safe.absPath,
        nextBytes: null,
        preimage,
      });
    }
  } catch (err) {
    return abort(err instanceof Error ? err.message : String(err), t0);
  }

  const plans = [...plansByRel.values()];
  if (plans.length === 0 && verifyList.length === 0) {
    return abort("provide at least one write, edit, delete, or verify command", t0);
  }

  const describe = (plan: PlannedWrite): string =>
    plan.nextBytes === null
      ? `${plan.relPath} (deleted)`
      : plan.preimage.existed
        ? plan.relPath
        : `${plan.relPath} (new)`;
  const fileList = plans.map((p) => p.relPath);
  const fileSummary = plans.map(describe).join(", ");

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
        if (plan.nextBytes === null) {
          fs.unlinkSync(plan.absPath);
        } else {
          const newDirs = missingParentDirs(plan.absPath, workspaceRoot);
          fs.mkdirSync(path.dirname(plan.absPath), { recursive: true });
          createdDirs.push(...newDirs);
          fs.writeFileSync(plan.absPath, plan.nextBytes);
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
      return {
        status: "APPLIED_NO_VERIFY",
        summary: `APPLIED_NO_VERIFY: ${fileList.length} file(s) changed (${fileSummary}). No verify command was given, so nothing was tested.`,
        filesModified: fileList,
        verifyPassed: false,
        rollbackErrors: [],
        elapsedMs: Math.round(performance.now() - t0),
      };
    }

    // Phase 4: verify, one command at a time, stopping at the first failure.
    const passedOutputs: string[] = [];
    for (const cmd of verifyList) {
      const run = await runVerifyCommand(cmd, workspaceRoot, timeoutMs, (child) => {
        activeChild = child;
      });
      if (run.ok) {
        passedOutputs.push(`$ ${cmd}  (passed)\n${tailText(run.output, PASS_OUTPUT_TAIL_BYTES) || "(no output)"}`);
        continue;
      }

      const reason = run.timedOut
        ? `timed out after ${timeoutMs}ms`
        : run.exitCode === null
          ? "could not be started"
          : `exit code ${run.exitCode}`;
      const failedOutput = `$ ${cmd}\n${run.output || "(no output)"}`;

      if (!shouldRollback) {
        return {
          status: "FAILED_KEPT_ON_DISK",
          summary: [
            `FAILED_KEPT_ON_DISK: verify "${cmd}" failed (${reason}). Changes kept on disk because rollback_on_fail=false: ${fileSummary || "none"}.`,
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
            : `Rollback Errors (${rollbackErrors.length}):\n  - ${rollbackErrors.join("\n  - ")}`,
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
        `SHIPPED_AND_VERIFIED in ${elapsedMs}ms: ${fileList.length} file(s) changed (${fileSummary || "verify-only"}).`,
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
