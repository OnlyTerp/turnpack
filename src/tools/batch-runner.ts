/**
 * Child-process half of `batch`. This file is the entry point of a short-lived Node process
 * that the parent starts (see batch.ts) with Node's permission model switched on: no file
 * writes, no child processes, no worker threads, reads limited to the workspace.
 *
 * Inside that process the model's script runs in a `node:vm` context that is given no object
 * from this (host) realm. Every host object carries a path back to the host `Function`
 * constructor, and from there to `process`, so the bridge passes strings only:
 *
 *   script  -> ctx.read("a.ts")            (function created inside the context)
 *           -> hostSync("read", "[\"a.ts\"]")   (closure-private, never on the global)
 *           <- "{\"ok\":true,\"value\":\"...\"}"
 *
 * `node:vm` is not a security boundary on its own, which is why the process-level restrictions
 * exist as the second layer and why anything privileged (ripgrep, git, optional exec) is done
 * by the parent over IPC rather than here.
 */
import fs from "node:fs";
import vm from "node:vm";
import { isSecretPath, resolveSafePath } from "../security.js";
import { extractSymbols, globToRegExp, isBinaryBuffer, walkWorkspaceFiles } from "../workspace.js";

interface RunMessage {
  t: "run";
  code: string;
  root: string;
  allowSecrets: boolean;
}

interface ReplyMessage {
  t: "reply";
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
}

const MAX_LOG_BYTES = 16000;

// Runs inside the context. Captures the intrinsics it needs up front, so a script that
// monkey-patches JSON or Promise can only break its own run.
const BRIDGE_SOURCE = `(function (hostSync, hostAsync, hostDone, maxLogBytes) {
  "use strict";
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const Err = Error;
  const Str = String;
  const P = Promise;
  const pThen = P.prototype.then;
  const apply = Reflect.apply;
  const freeze = Object.freeze;
  const logs = [];
  let logBytes = 0;

  function callSync(op, args) {
    let out;
    try {
      out = hostSync(op, stringify(args));
    } catch (_) {
      throw new Err("turnpack bridge failure");
    }
    const res = parse(out);
    if (!res.ok) throw new Err(res.error);
    return res.value;
  }

  function callAsync(op, args) {
    return new P(function (resolve, reject) {
      try {
        hostAsync(
          op,
          stringify(args),
          function (out) { resolve(parse(out)); },
          function (msg) { reject(new Err(Str(msg))); }
        );
      } catch (_) {
        reject(new Err("turnpack bridge failure"));
      }
    });
  }

  const ctx = freeze({
    files: function (glob) { return callSync("files", [glob]); },
    read: function (path, startLine, endLine) { return callSync("read", [path, startLine, endLine]); },
    outline: function (path) { return callSync("outline", [path]); },
    grep: function (pattern, opts) { return callAsync("grep", [pattern, opts]); },
    gitStatus: function () { return callAsync("gitStatus", []); },
    exec: function (command) { return callAsync("exec", [command]); }
  });

  function show(x) {
    if (typeof x === "string") return x;
    try {
      const s = stringify(x);
      return s === undefined ? Str(x) : s;
    } catch (_) {
      try { return Str(x); } catch (__) { return "[unprintable]"; }
    }
  }

  function log() {
    if (logBytes >= maxLogBytes) return;
    let line = "";
    for (let i = 0; i < arguments.length; i++) line += (i ? " " : "") + show(arguments[i]);
    logBytes += line.length;
    logs[logs.length] = logBytes > maxLogBytes ? line + " [log limit reached]" : line;
  }
  const console = freeze({ log: log, info: log, warn: log, error: log, debug: log });

  function describe(e) {
    try {
      if (e && typeof e === "object" && typeof e.message === "string") {
        return (typeof e.name === "string" ? e.name : "Error") + ": " + e.message;
      }
      return Str(e);
    } catch (_) {
      return "script threw an unprintable value";
    }
  }

  function finish(ok, text) {
    let logText = "";
    for (let i = 0; i < logs.length; i++) logText += (i ? "\\n" : "") + logs[i];
    hostDone(ok, text, logText);
  }

  return function run(userFn) {
    let pending;
    try {
      pending = P.resolve(userFn(ctx, console));
    } catch (e) {
      finish(false, describe(e));
      return;
    }
    apply(pThen, pending, [
      function (value) {
        let text;
        try {
          if (value === undefined) {
            text = "(undefined)";
          } else if (typeof value === "string") {
            text = value;
          } else {
            const pretty = stringify(value, null, 2);
            text = typeof pretty === "string" ? pretty : Str(value);
          }
        } catch (e) {
          finish(false, "result could not be serialized: " + describe(e));
          return;
        }
        finish(true, text);
      },
      function (e) { finish(false, describe(e)); }
    ]);
  };
})`;

function send(message: Record<string, unknown>): void {
  process.send?.(message);
}

/**
 * A script is either a function expression (`async (ctx) => { ... }`) or a plain body that may
 * use `await` and `return`. A body can also *start* with a function declaration, so the
 * function-expression reading is only a first guess; the caller falls back to the body form
 * when that guess does not compile.
 */
function candidateSources(rawCode: string): string[] {
  const trimmed = rawCode.trim().replace(/;+\s*$/, "");
  const asBody = `return (async () => {\n${rawCode}\n})();`;
  const looksLikeFunction =
    /^(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>|^async\s+function\b|^function\b/.test(trimmed);
  return looksLikeFunction ? [`return (${trimmed}\n)(ctx, console);`, asBody] : [asBody];
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function execute(msg: RunMessage): void {
  const { root, allowSecrets } = msg;
  const pending = new Map<number, { onOk: (out: string) => void; onErr: (msg: string) => void }>();
  let nextCallId = 1;
  let finished = false;

  const syncOps: Record<string, (args: unknown[]) => unknown> = {
    files(args) {
      const glob = args[0];
      const walk = walkWorkspaceFiles(root, { allowSecrets });
      const visible = allowSecrets ? walk.files : walk.files.filter((rel) => !isSecretPath(rel));
      if (typeof glob !== "string" || !glob.trim()) return visible;
      const rx = globToRegExp(glob.trim());
      return visible.filter((rel) => rx.test(rel));
    },
    read(args) {
      const [relPath, startLine, endLine] = args;
      if (typeof relPath !== "string") throw new Error("ctx.read(path): path must be a string");
      const safe = resolveSafePath(root, relPath);
      if (!allowSecrets && isSecretPath(safe.relPath)) {
        return `[REDACTED SECRET FILE: ${safe.relPath}]`;
      }
      const buf = fs.readFileSync(safe.absPath);
      if (isBinaryBuffer(buf)) return `[BINARY FILE: ${safe.relPath}]`;
      const text = buf.toString("utf8");
      if (typeof startLine !== "number" && typeof endLine !== "number") return text;
      const lines = text.split(/\r?\n/);
      const start = Math.max(1, typeof startLine === "number" ? Math.trunc(startLine) : 1);
      const end = Math.min(lines.length, typeof endLine === "number" ? Math.trunc(endLine) : lines.length);
      return lines.slice(start - 1, end).join("\n");
    },
    outline(args) {
      const relPath = args[0];
      if (typeof relPath !== "string") throw new Error("ctx.outline(path): path must be a string");
      const safe = resolveSafePath(root, relPath);
      if (!allowSecrets && isSecretPath(safe.relPath)) return [];
      const buf = fs.readFileSync(safe.absPath);
      return isBinaryBuffer(buf) ? [] : extractSymbols(buf.toString("utf8"));
    },
  };

  // The three host functions below are the only host-realm values the context ever receives,
  // and the bridge keeps them in a closure. They take and return primitives and never throw.
  const hostSync = (op: unknown, payload: unknown): string => {
    try {
      if (typeof op !== "string" || typeof payload !== "string") {
        return JSON.stringify({ ok: false, error: "invalid bridge call" });
      }
      const handler = Object.hasOwn(syncOps, op) ? syncOps[op] : undefined;
      if (!handler) return JSON.stringify({ ok: false, error: `unknown operation ${op}` });
      const args = JSON.parse(payload) as unknown;
      const value = handler(Array.isArray(args) ? args : []);
      return JSON.stringify({ ok: true, value: value === undefined ? null : value });
    } catch (err) {
      // Under the permission model, a path outside the workspace is refused by Node before our
      // own check sees it. Same outcome, so report it the same way.
      const denied = (err as NodeJS.ErrnoException | null)?.code === "ERR_ACCESS_DENIED";
      return JSON.stringify({
        ok: false,
        error: denied ? "ERR_PATH_OUTSIDE_WORKSPACE: path is outside the workspace" : errorText(err),
      });
    }
  };

  const hostAsync = (op: unknown, payload: unknown, onOk: unknown, onErr: unknown): void => {
    if (typeof onOk !== "function" || typeof onErr !== "function") return;
    const ok = onOk as (out: string) => void;
    const fail = onErr as (msg: string) => void;
    try {
      if (typeof op !== "string" || typeof payload !== "string") {
        fail("invalid bridge call");
        return;
      }
      const id = nextCallId++;
      pending.set(id, { onOk: ok, onErr: fail });
      send({ t: "call", id, op, args: JSON.parse(payload) as unknown });
    } catch (err) {
      try {
        fail(errorText(err));
      } catch {
        // The script's own handler threw; nothing to report to.
      }
    }
  };

  const hostDone = (ok: unknown, text: unknown, logs: unknown): void => {
    if (finished) return;
    finished = true;
    send({
      t: "done",
      ok: ok === true,
      text: typeof text === "string" ? text : "(non-string result)",
      logs: typeof logs === "string" ? logs : "",
    });
  };

  process.on("message", (raw: unknown) => {
    const reply = raw as ReplyMessage | null;
    if (!reply || reply.t !== "reply" || typeof reply.id !== "number") return;
    const waiter = pending.get(reply.id);
    if (!waiter) return;
    pending.delete(reply.id);
    try {
      if (reply.ok) {
        waiter.onOk(JSON.stringify(reply.value === undefined ? null : reply.value));
      } else {
        waiter.onErr(typeof reply.error === "string" ? reply.error : "operation failed");
      }
    } catch {
      // A throwing continuation is the script's problem; it surfaces as its own rejection.
    }
  });

  try {
    const context = vm.createContext(Object.create(null) as object, {
      name: "turnpack-batch",
      codeGeneration: { strings: false, wasm: false },
    });
    // Errors raised for a dynamic import() must come from the context's own realm; a host-realm
    // Error would hand the script the host Function constructor.
    const importBlocked = vm.runInContext(
      `(function () { return new Error("import() is not available in batch scripts; use the ctx helpers"); })`,
      context,
    ) as () => unknown;
    const blockImport = (): never => {
      throw importBlocked();
    };

    const makeRunner = vm.runInContext(BRIDGE_SOURCE, context, {
      filename: "turnpack-bridge.js",
      importModuleDynamically: blockImport,
    }) as (...hostFns: unknown[]) => (userFn: unknown) => void;
    const run = makeRunner(hostSync, hostAsync, hostDone, MAX_LOG_BYTES);

    let userFn: unknown;
    let compileError = "";
    for (const source of candidateSources(msg.code)) {
      try {
        userFn = vm.compileFunction(source, ["ctx", "console"], {
          parsingContext: context,
          filename: "batch-script.js",
          importModuleDynamically: blockImport,
        });
        break;
      } catch (err) {
        compileError = errorText(err);
      }
    }
    if (userFn === undefined) {
      hostDone(false, /^\w*Error:/.test(compileError) ? compileError : `SyntaxError: ${compileError}`, "");
      return;
    }
    run(userFn);
  } catch (err) {
    hostDone(false, errorText(err), "");
  }
}

process.on("message", (raw: unknown) => {
  const msg = raw as RunMessage | null;
  if (!msg || msg.t !== "run" || typeof msg.code !== "string" || typeof msg.root !== "string") return;

  // If the permission flags did not scope reads to this workspace (an unusual path, an older
  // runtime), say so instead of failing every ctx.read with an access error.
  const permission = (process as { permission?: { has: (scope: string, ref?: string) => boolean } }).permission;
  if (permission && !permission.has("fs.read", msg.root)) {
    send({ t: "scope-mismatch" });
    return;
  }
  execute({ t: "run", code: msg.code, root: msg.root, allowSecrets: msg.allowSecrets === true });
});

// A script that leaves a rejected promise behind, or throws from a detached continuation, must
// not take the process down before its result is delivered. The error values belong to the
// script's realm, so they are deliberately not inspected here.
process.on("unhandledRejection", () => {});
process.on("uncaughtException", () => {
  send({ t: "done", ok: false, text: "script raised an uncaught exception", logs: "" });
});

send({
  t: "ready",
  permission: Boolean((process as { permission?: unknown }).permission),
});
