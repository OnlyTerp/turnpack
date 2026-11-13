import { spawn } from "node:child_process";
import path from "node:path";

export const CLI_PATH = path.resolve(import.meta.dirname, "..", "dist", "cli.js");

/**
 * A minimal MCP client over stdio (newline-delimited JSON) for exercising the real server.
 * `onServerRequest` lets a test play the client side of server-initiated requests (roots/list).
 */
export function startSession({ cwd, env = {}, onServerRequest } = {}) {
  // Start from an environment with none of the variables that pick the workspace root, so a
  // test means the same thing whether or not the suite itself runs inside an AI coding app.
  const baseEnv = { ...process.env };
  delete baseEnv.TURNPACK_ROOT;
  delete baseEnv.CLAUDE_PROJECT_DIR;
  delete baseEnv.TURNPACK_ALLOW_EXEC;
  const child = spawn(process.execPath, [CLI_PATH, "serve"], {
    cwd,
    env: { ...baseEnv, ...env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  let nextId = 1;
  let buffer = "";
  let stderr = "";
  const waiting = new Map();
  const unsolicited = [];

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (typeof msg.method === "string" && msg.id !== undefined) {
        const result = onServerRequest ? onServerRequest(msg) : undefined;
        if (result !== undefined) {
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n`);
        }
        continue;
      }
      const waiter = waiting.get(msg.id);
      if (waiter) {
        waiting.delete(msg.id);
        waiter(msg);
      } else {
        unsolicited.push(msg);
      }
    }
  });

  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`No response to ${method} within 10s. stderr: ${stderr}`));
      }, 10000);
      waiting.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
    });

  return {
    child,
    unsolicited,
    request,
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) })}\n`);
    },
    sendRaw(text) {
      child.stdin.write(text);
    },
    /** Calls a tool and returns `{ text, isError, error }`. */
    async call(name, args) {
      const msg = await request("tools/call", { name, arguments: args });
      return {
        text: msg.result?.content?.[0]?.text ?? "",
        isError: msg.result?.isError === true,
        error: msg.error,
      };
    },
    async initialize(extra = {}) {
      return request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "turnpack-test" },
        ...extra,
      });
    },
    close() {
      return new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("close", () => resolve());
        child.stdin.end();
        child.kill();
      });
    },
  };
}

export function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
