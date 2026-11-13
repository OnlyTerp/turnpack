import { fork, spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveWorkspaceRoot } from "../security.js";
import { isRecord, optionalBoolean, optionalNumber, optionalString, requiredString } from "../validate.js";
import { runGitStatus, runSearch, type SearchHit, type SymbolOutline } from "../workspace.js";

export interface BatchArgs {
  cwd?: string;
  code: string;
  timeout_ms?: number;
  allow_secrets?: boolean;
}

/** The API a batch script sees as `ctx`. Documented here; implemented in batch-runner.ts. */
export interface BatchCtx {
  files: (glob?: string) => string[];
  read: (relPath: string, startLine?: number, endLine?: number) => string;
  grep: (
    pattern: string,
    opts?: { literal?: boolean; maxMatches?: number },
  ) => Promise<SearchHit[]>;
  outline: (relPath: string) => SymbolOutline[];
  gitStatus: () => Promise<string>;
  exec: (command: string) => Promise<{ stdout: string; stderr: string }>;
}

/**
 * How a batch script was contained:
 * - "permission": separate process started with Node's permission model (no writes, no child
 *   processes, no workers, reads limited to the workspace).
 * - "process": separate process only, because this Node build or platform could not start
 *   the runner with the permission model.
 */
export type BatchIsolation = "permission" | "process";

export interface BatchOutcome {
  text: string;
  isolation: BatchIsolation;
  ok: boolean;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = path.join(HERE, "batch-runner.js");
const PACKAGE_ROOT = path.resolve(HERE, "..", "..");
const MAX_RESULT_BYTES = 48000;
const MAX_EXEC_CAPTURE = 262144;
const STARTUP_GRACE_MS = 10000;
const RUNNER_EXIT_WAIT_MS = 2000;

// Decided on first use and remembered: undefined = not tried yet.
let permissionModelUsable: boolean | undefined;

function permissionFlag(): string | null {
  const flags = process.allowedNodeEnvironmentFlags;
  if (flags.has("--permission")) return "--permission";
  if (flags.has("--experimental-permission")) return "--experimental-permission";
  return null;
}

/** The runner needs nothing from the parent's environment, so it does not get the API keys in it. */
function minimalEnv(): NodeJS.ProcessEnv {
  const keep = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL"];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keep) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function execIsEnabled(): boolean {
  return process.env.TURNPACK_ALLOW_EXEC === "1";
}

function runExec(command: string, cwd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveExec, rejectExec) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      rejectExec(new Error(`batch exec timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_EXEC_CAPTURE) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_EXEC_CAPTURE) stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      rejectExec(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveExec({ stdout, stderr });
      else rejectExec(new Error(`Command exited with code ${code}: ${stderr || stdout}`));
    });
  });
}

type Attempt =
  | { kind: "done"; ok: boolean; text: string; logs: string; permission: boolean }
  | { kind: "retry-without-permission"; detail: string }
  | { kind: "failed"; message: string };

interface RunSpec {
  code: string;
  root: string;
  allowSecrets: boolean;
  timeoutMs: number;
}

function attemptRun(spec: RunSpec, usePermission: boolean): Promise<Attempt> {
  return new Promise((resolveAttempt) => {
    const flag = usePermission ? permissionFlag() : null;
    // --experimental-vm-modules is what makes Node hand a script's dynamic import() to the
    // runner's own callback; without it Node rejects with an error object from the host realm,
    // and a host-realm object is exactly what the runner must never give a script.
    const execArgv = ["--max-old-space-size=512", "--experimental-vm-modules", "--no-warnings"];
    if (flag) {
      execArgv.push(flag, `--allow-fs-read=${spec.root}`, `--allow-fs-read=${PACKAGE_ROOT}`);
    }

    let child: ChildProcess;
    try {
      child = fork(RUNNER_PATH, [], {
        // Not the workspace: every path the runner touches is resolved against spec.root
        // explicitly, and on Windows a process pins its working directory, which would stop
        // the workspace from being renamed or removed while (and just after) a script runs.
        cwd: PACKAGE_ROOT,
        env: minimalEnv(),
        execArgv,
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        windowsHide: true,
      });
    } catch (err) {
      resolveAttempt(
        flag
          ? { kind: "retry-without-permission", detail: err instanceof Error ? err.message : String(err) }
          : { kind: "failed", message: `could not start batch runner: ${err instanceof Error ? err.message : String(err)}` },
      );
      return;
    }

    let settled = false;
    let ready = false;
    let permissionActive = false;
    let stderrText = "";
    const startedAt = performance.now();

    const settle = (attempt: Attempt): void => {
      if (settled) return;
      settled = true;
      clearTimeout(startupTimer);
      clearTimeout(runTimer);
      child.removeAllListeners("message");
      const finish = (): void => resolveAttempt(attempt);
      const alreadyGone = child.exitCode !== null || child.signalCode !== null || child.pid === undefined;
      if (alreadyGone) {
        finish();
        return;
      }
      // Return only once the runner is really gone, so no process of ours outlives the call.
      const giveUp = setTimeout(finish, RUNNER_EXIT_WAIT_MS);
      child.once("exit", () => {
        clearTimeout(giveUp);
        finish();
      });
      child.kill("SIGKILL");
    };

    const startupTimer = setTimeout(() => {
      settle(
        flag
          ? { kind: "retry-without-permission", detail: "runner did not start in time" }
          : { kind: "failed", message: "batch runner did not start in time" },
      );
    }, STARTUP_GRACE_MS);

    // The wall-clock limit is enforced from outside the runner, so a script stuck in
    // `while (true) {}` (even after an await) is killed instead of hanging the server.
    let runTimer: NodeJS.Timeout | undefined;

    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrText.length < 4000) stderrText += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      settle(
        flag && !ready
          ? { kind: "retry-without-permission", detail: err.message }
          : { kind: "failed", message: `batch runner error: ${err.message}` },
      );
    });

    child.on("exit", (code, signal) => {
      if (settled) return;
      const detail = stderrText.trim().split("\n").slice(-3).join(" | ") || `exit ${code ?? signal}`;
      settle(
        flag && !ready
          ? { kind: "retry-without-permission", detail }
          : { kind: "failed", message: `batch runner stopped before returning a result (${detail})` },
      );
    });

    const reply = (id: number, body: { ok: true; value: unknown } | { ok: false; error: string }): void => {
      if (!settled && child.connected) child.send({ t: "reply", id, ...body });
    };

    child.on("message", (raw: unknown) => {
      if (!isRecord(raw)) return;

      if (raw.t === "ready") {
        ready = true;
        permissionActive = raw.permission === true;
        clearTimeout(startupTimer);
        runTimer = setTimeout(() => {
          settle({ kind: "failed", message: `batch timed out after ${spec.timeoutMs}ms` });
        }, spec.timeoutMs);
        child.send({ t: "run", code: spec.code, root: spec.root, allowSecrets: spec.allowSecrets });
        return;
      }

      if (raw.t === "scope-mismatch") {
        settle({ kind: "retry-without-permission", detail: "permission scope did not cover the workspace" });
        return;
      }

      if (raw.t === "done") {
        settle({
          kind: "done",
          ok: raw.ok === true,
          text: typeof raw.text === "string" ? raw.text : "",
          logs: typeof raw.logs === "string" ? raw.logs : "",
          permission: permissionActive,
        });
        return;
      }

      // Privileged helpers run here, in the parent. The runner only names the operation; the
      // workspace root and the secret policy are the parent's own values, never the runner's.
      if (raw.t === "call" && typeof raw.id === "number" && typeof raw.op === "string") {
        const id = raw.id;
        const callArgs = Array.isArray(raw.args) ? (raw.args as unknown[]) : [];
        const fail = (err: unknown): void =>
          reply(id, { ok: false, error: err instanceof Error ? err.message : String(err) });

        if (raw.op === "grep") {
          const pattern = callArgs[0];
          const opts = isRecord(callArgs[1]) ? callArgs[1] : {};
          if (typeof pattern !== "string" || !pattern) {
            fail("ctx.grep(pattern): pattern must be a non-empty string");
            return;
          }
          runSearch(spec.root, pattern, {
            literal: opts.literal === true,
            allowSecrets: spec.allowSecrets,
            maxMatches: typeof opts.maxMatches === "number" ? opts.maxMatches : 80,
          }).then((res) => reply(id, { ok: true, value: res.hits }), fail);
          return;
        }
        if (raw.op === "gitStatus") {
          runGitStatus(spec.root).then((value) => reply(id, { ok: true, value }), fail);
          return;
        }
        if (raw.op === "exec") {
          const command = callArgs[0];
          if (!execIsEnabled()) {
            fail(
              "ERR_EXEC_DISABLED: batch is read-only by default. Set TURNPACK_ALLOW_EXEC=1 to enable local command execution.",
            );
            return;
          }
          if (typeof command !== "string" || !command.trim()) {
            fail("ctx.exec(command): command must be a non-empty string");
            return;
          }
          const remaining = Math.max(250, spec.timeoutMs - (performance.now() - startedAt));
          runExec(command, spec.root, remaining).then((value) => reply(id, { ok: true, value }), fail);
          return;
        }
        fail(`unknown operation ${raw.op}`);
      }
    });
  });
}

function capResult(text: string): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= MAX_RESULT_BYTES) return text;
  const head = Buffer.from(text, "utf8").subarray(0, MAX_RESULT_BYTES).toString("utf8");
  return `${head}\n[... result truncated: ${bytes} bytes exceeds the ${MAX_RESULT_BYTES}-byte cap. Return a summary (counts, names, the few lines that matter) instead of raw file contents.]`;
}

/** Runs a script and reports how it was contained. Throws when the script itself fails. */
export async function runBatchDetailed(args: BatchArgs): Promise<BatchOutcome> {
  const t0 = performance.now();
  const raw: Record<string, unknown> = isRecord(args) ? args : {};
  const code = requiredString(raw.code, "batch.code");
  const root = resolveWorkspaceRoot(optionalString(raw.cwd, "batch.cwd"));
  const allowSecrets = optionalBoolean(raw.allow_secrets, "batch.allow_secrets") ?? false;
  const timeoutMs = Math.min(
    30000,
    Math.max(250, Math.trunc(optionalNumber(raw.timeout_ms, "batch.timeout_ms") ?? 5000)),
  );
  const spec: RunSpec = { code, root, allowSecrets, timeoutMs };

  let attempt: Attempt;
  if (permissionModelUsable !== false && permissionFlag()) {
    attempt = await attemptRun(spec, true);
    if (attempt.kind === "retry-without-permission") {
      permissionModelUsable = false;
      attempt = await attemptRun(spec, false);
    } else if (attempt.kind === "done") {
      permissionModelUsable = true;
    }
  } else {
    attempt = await attemptRun(spec, false);
  }

  if (attempt.kind !== "done") {
    throw new Error(attempt.kind === "failed" ? attempt.message : `batch runner unavailable: ${attempt.detail}`);
  }

  const elapsedMs = Math.round(performance.now() - t0);
  const isolation: BatchIsolation = attempt.permission ? "permission" : "process";
  const logBlock = attempt.logs ? [`Logs:\n${attempt.logs}`] : [];

  if (!attempt.ok) {
    throw new Error([`batch script failed: ${attempt.text}`, ...logBlock].join("\n\n"));
  }
  return {
    ok: true,
    isolation,
    text: [`BATCH OK (${elapsedMs}ms)`, ...logBlock, `Result:\n${capResult(attempt.text)}`].join("\n\n"),
  };
}

export async function runBatch(args: BatchArgs): Promise<string> {
  return (await runBatchDetailed(args)).text;
}
