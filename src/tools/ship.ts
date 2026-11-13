import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isSecretPath, resolveSafePath, resolveWorkspaceRoot } from "../security.js";

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
  verify?: string | string[];
  timeout_ms?: number;
  rollback_on_fail?: boolean;
  rollback_on_verify_fail?: boolean;
  allow_secrets?: boolean;
}

export interface RestoreOps {
  writeFile: (absPath: string, bytes: Buffer) => void;
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
}

interface PlannedWrite {
  relPath: string;
  absPath: string;
  nextBytes: Buffer;
  preimage: Preimage;
}

interface TurnpackProjectConfig {
  enforceVerifyAllowlist?: boolean;
  allowedVerify?: string[];
}

function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function loadProjectConfig(workspaceRoot: string): TurnpackProjectConfig {
  const cfgPath = path.join(workspaceRoot, ".turnpack.json");
  if (!fs.existsSync(cfgPath)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as unknown;
    if (raw && typeof raw === "object") {
      return raw as TurnpackProjectConfig;
    }
  } catch {
    // Malformed .turnpack.json falls back cleanly; handled conservatively below if needed.
  }
  return {};
}

function replaceAllExact(haystack: string, needle: string, replacement: string): {
  text: string;
  count: number;
} {
  if (!needle) return { text: haystack, count: 0 };
  const parts = haystack.split(needle);
  const count = parts.length - 1;
  return { text: parts.join(replacement), count };
}

function killProcessTree(pid: number): Promise<void> {
  return new Promise((resolveKill) => {
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("close", () => resolveKill());
      killer.on("error", () => resolveKill());
      return;
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Ignore already-exited process.
      }
    }
    resolveKill();
  });
}

async function runVerifyCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ ok: boolean; exitCode: number | null; timedOut: boolean; output: string }> {
  return await new Promise((resolveRun) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const appendChunk = (chunk: Buffer): void => {
      if (totalBytes >= 24576) return;
      const take = chunk.subarray(0, 24576 - totalBytes);
      chunks.push(take);
      totalBytes += take.length;
    };

    child.stdout?.on("data", appendChunk);
    child.stderr?.on("data", appendChunk);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        void killProcessTree(child.pid);
      }
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolveRun({ ok: false, exitCode: 1, timedOut, output: err.message });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const output = Buffer.concat(chunks).toString("utf8").trim();
      resolveRun({
        ok: !timedOut && code === 0,
        exitCode: code,
        timedOut,
        output,
      });
    });
  });
}

const DEFAULT_RESTORE_OPS: RestoreOps = {
  writeFile: (absPath, bytes) => {
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, bytes);
  },
  unlink: (absPath) => {
    if (fs.existsSync(absPath)) {
      fs.unlinkSync(absPath);
    }
  },
  readFile: (absPath) => fs.readFileSync(absPath),
};

function restoreSnapshots(
  plans: PlannedWrite[],
  ops: RestoreOps,
): string[] {
  const errors: string[] = [];
  for (let i = plans.length - 1; i >= 0; i--) {
    const plan = plans[i];
    if (!plan) continue;
    const { preimage } = plan;
    try {
      if (preimage.existed) {
        ops.writeFile(preimage.absPath, preimage.bytes);
        const actual = ops.readFile(preimage.absPath);
        if (sha256(actual) !== preimage.sha256) {
          errors.push(`${preimage.relPath}: restored checksum mismatch`);
        }
      } else {
        ops.unlink(preimage.absPath);
      }
    } catch (err) {
      errors.push(`${preimage.relPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return errors;
}

export async function runShip(
  args: ShipArgs,
  internalOpts: { restoreOps?: RestoreOps } = {},
): Promise<ShipResult> {
  const t0 = performance.now();
  const workspaceRoot = resolveWorkspaceRoot(args.cwd);
  const allowSecrets = Boolean(args.allow_secrets);
  const shouldRollback = args.rollback_on_fail ?? args.rollback_on_verify_fail ?? true;
  const timeoutMs = Math.min(300000, Math.max(1000, args.timeout_ms ?? 60000));
  const restoreOps = internalOpts.restoreOps ?? DEFAULT_RESTORE_OPS;

  const verifyList = Array.isArray(args.verify)
    ? args.verify.map((s) => s.trim()).filter(Boolean)
    : typeof args.verify === "string" && args.verify.trim()
      ? [args.verify.trim()]
      : [];

  if (verifyList.length > 0) {
    const cfg = loadProjectConfig(workspaceRoot);
    if (cfg.enforceVerifyAllowlist) {
      const allowed = cfg.allowedVerify ?? [];
      for (const cmd of verifyList) {
        const isAllowed = allowed.some((prefix) => cmd === prefix || cmd.startsWith(`${prefix} `));
        if (!isAllowed) {
          return {
            status: "ABORTED_BEFORE_WRITE",
            summary: `ABORTED_BEFORE_WRITE: verify command "${cmd}" is not in .turnpack.json allowedVerify list`,
            filesModified: [],
            verifyPassed: false,
            rollbackErrors: [],
            elapsedMs: Math.round(performance.now() - t0),
          };
        }
      }
    }
  }

  // Phase 1 & 2: Validate every write & edit in memory and snapshot preimages before writing.
  const plansByRel = new Map<string, PlannedWrite>();

  try {
    for (const writeOp of args.writes ?? []) {
      const safe = resolveSafePath(workspaceRoot, writeOp.path);
      if (!allowSecrets && isSecretPath(safe.relPath)) {
        throw new Error(`Secret file write blocked for "${safe.relPath}" (pass allow_secrets: true to override)`);
      }

      const existed = fs.existsSync(safe.absPath);
      const origBytes = existed ? fs.readFileSync(safe.absPath) : Buffer.alloc(0);
      const origSha = existed ? sha256(origBytes) : "";

      if (writeOp.expected_sha256 && existed && origSha !== writeOp.expected_sha256) {
        throw new Error(`Precondition failed for "${safe.relPath}": SHA-256 changed on disk`);
      }

      const existingPlan = plansByRel.get(safe.relPath);
      const preimage: Preimage = existingPlan?.preimage ?? {
        relPath: safe.relPath,
        absPath: safe.absPath,
        existed,
        bytes: origBytes,
        sha256: origSha,
      };

      plansByRel.set(safe.relPath, {
        relPath: safe.relPath,
        absPath: safe.absPath,
        nextBytes: Buffer.from(writeOp.content, "utf8"),
        preimage,
      });
    }

    for (const editOp of args.edits ?? []) {
      const safe = resolveSafePath(workspaceRoot, editOp.path);
      if (!allowSecrets && isSecretPath(safe.relPath)) {
        throw new Error(`Secret file edit blocked for "${safe.relPath}" (pass allow_secrets: true to override)`);
      }

      if (!fs.existsSync(safe.absPath)) {
        throw new Error(`Edit target not found: "${safe.relPath}"`);
      }

      const existingPlan = plansByRel.get(safe.relPath);
      let preimage: Preimage;
      let workingText: string;

      if (existingPlan) {
        preimage = existingPlan.preimage;
        workingText = existingPlan.nextBytes.toString("utf8");
      } else {
        const stat = fs.statSync(safe.absPath);
        const origBytes = fs.readFileSync(safe.absPath);
        const origSha = sha256(origBytes);
        if (editOp.expected_sha256 && origSha !== editOp.expected_sha256) {
          throw new Error(`Precondition failed for "${safe.relPath}": SHA-256 changed on disk`);
        }
        if (
          editOp.expected_mtime_ms !== undefined &&
          Math.abs(stat.mtimeMs - editOp.expected_mtime_ms) > 5
        ) {
          throw new Error(`Precondition failed for "${safe.relPath}": mtime changed on disk`);
        }
        preimage = {
          relPath: safe.relPath,
          absPath: safe.absPath,
          existed: true,
          bytes: origBytes,
          sha256: origSha,
        };
        workingText = origBytes.toString("utf8");
      }

      const changes: ShipEditChange[] =
        editOp.changes && editOp.changes.length > 0
          ? editOp.changes
          : editOp.search !== undefined && editOp.replace !== undefined
            ? [{ search: editOp.search, replace: editOp.replace, replace_all: editOp.replace_all }]
            : [];

      if (changes.length === 0) {
        throw new Error(`Edit for "${safe.relPath}" requires search+replace or changes[]`);
      }

      for (const ch of changes) {
        if (!ch.search) {
          throw new Error(`Empty search anchor in edit for "${safe.relPath}"`);
        }
        const replaced = replaceAllExact(workingText, ch.search, ch.replace);
        if (replaced.count === 0) {
          throw new Error(`Anchor not found in "${safe.relPath}": ${JSON.stringify(ch.search.slice(0, 80))}`);
        }
        if (replaced.count > 1 && !ch.replace_all) {
          throw new Error(
            `Ambiguous anchor in "${safe.relPath}" matched ${replaced.count} times (pass replace_all: true or add context)`,
          );
        }
        workingText = replaced.text;
      }

      plansByRel.set(safe.relPath, {
        relPath: safe.relPath,
        absPath: safe.absPath,
        nextBytes: Buffer.from(workingText, "utf8"),
        preimage,
      });
    }
  } catch (err) {
    return {
      status: "ABORTED_BEFORE_WRITE",
      summary: `ABORTED_BEFORE_WRITE: ${err instanceof Error ? err.message : String(err)}`,
      filesModified: [],
      verifyPassed: false,
      rollbackErrors: [],
      elapsedMs: Math.round(performance.now() - t0),
    };
  }

  const plans = [...plansByRel.values()];
  if (plans.length === 0 && verifyList.length === 0) {
    return {
      status: "ABORTED_BEFORE_WRITE",
      summary: "ABORTED_BEFORE_WRITE: provide at least one write, edit, or verify command",
      filesModified: [],
      verifyPassed: false,
      rollbackErrors: [],
      elapsedMs: Math.round(performance.now() - t0),
    };
  }

  // Phase 3: Write updated files.
  const writtenSoFar: PlannedWrite[] = [];
  try {
    for (const plan of plans) {
      fs.mkdirSync(path.dirname(plan.absPath), { recursive: true });
      fs.writeFileSync(plan.absPath, plan.nextBytes);
      writtenSoFar.push(plan);
    }
  } catch (err) {
    const rbErrors = restoreSnapshots(writtenSoFar, restoreOps);
    return {
      status: rbErrors.length > 0 ? "FAILED_ROLLBACK_PARTIAL" : "FAILED_AND_ROLLED_BACK",
      summary: `Write failed (${err instanceof Error ? err.message : String(err)}). Rollback errors: ${rbErrors.length}`,
      filesModified: [],
      verifyPassed: false,
      rollbackErrors: rbErrors,
      elapsedMs: Math.round(performance.now() - t0),
    };
  }

  const fileList = plans.map((p) => p.relPath);
  if (verifyList.length === 0) {
    return {
      status: "APPLIED_NO_VERIFY",
      summary: `APPLIED_NO_VERIFY: updated ${fileList.length} file(s): ${fileList.join(", ")}`,
      filesModified: fileList,
      verifyPassed: false,
      rollbackErrors: [],
      elapsedMs: Math.round(performance.now() - t0),
    };
  }

  // Phase 4: Run verification commands sequentially.
  const verifyOutputs: string[] = [];
  for (const cmd of verifyList) {
    const run = await runVerifyCommand(cmd, workspaceRoot, timeoutMs);
    verifyOutputs.push(`$ ${cmd}\n${run.output || "(no output)"}`);
    if (!run.ok) {
      const reason = run.timedOut ? `timed out after ${timeoutMs}ms` : `exit code ${run.exitCode}`;
      if (!shouldRollback) {
        return {
          status: "FAILED_KEPT_ON_DISK",
          summary: [
            `FAILED_KEPT_ON_DISK: "${cmd}" failed (${reason}). Edits kept on disk because rollback_on_fail=false.`,
            ...verifyOutputs,
          ].join("\n\n"),
          filesModified: fileList,
          verifyPassed: false,
          rollbackErrors: [],
          elapsedMs: Math.round(performance.now() - t0),
        };
      }

      const rollbackErrors = restoreSnapshots(plans, restoreOps);
      const status: ShipStatus =
        rollbackErrors.length > 0 ? "FAILED_ROLLBACK_PARTIAL" : "FAILED_AND_ROLLED_BACK";

      const lines = [
        `${status}: verify "${cmd}" failed (${reason}).`,
        rollbackErrors.length === 0
          ? `Restored ${plans.length} file(s) to byte-exact pre-edit snapshots.`
          : `Rollback Errors (${rollbackErrors.length}):\n  - ${rollbackErrors.join("\n  - ")}`,
        ...verifyOutputs,
      ];

      return {
        status,
        summary: lines.join("\n\n"),
        filesModified: rollbackErrors.length === 0 ? [] : fileList,
        verifyPassed: false,
        rollbackErrors,
        elapsedMs: Math.round(performance.now() - t0),
      };
    }
  }

  const elapsedMs = Math.round(performance.now() - t0);
  return {
    status: "SHIPPED_AND_VERIFIED",
    summary: [
      `SHIPPED_AND_VERIFIED in ${elapsedMs}ms: ${fileList.length} file(s) updated (${fileList.join(", ") || "verify-only"}).`,
      ...verifyOutputs,
    ].join("\n\n"),
    filesModified: fileList,
    verifyPassed: true,
    rollbackErrors: [],
    elapsedMs,
  };
}
