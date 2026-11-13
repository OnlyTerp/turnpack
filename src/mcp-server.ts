import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { describeChecks, detectChecks } from "./checks.js";
import {
  applyClientRoots,
  configScope,
  createRootPolicy,
  resolveToolRoot,
  type RootPolicy,
} from "./roots.js";
import { runBatch, type BatchArgs } from "./tools/batch.js";
import { runPack, type ClientContext, type PackArgs } from "./tools/pack.js";
import { runShip, type ShipArgs } from "./tools/ship.js";
import { isRecord, pick, ROOT_KEYS } from "./validate.js";
import { VERSION } from "./version.js";

export interface McpToolDefinition {
  name: "pack" | "ship" | "batch";
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    title: string;
    readOnlyHint: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint: boolean;
  };
  _meta?: Record<string, unknown>;
}

/**
 * Claude Code defers MCP tools by default: the model sees their names and has to search for a
 * tool before it can call it. That extra step is paid on every first use, and it is the reason
 * a model with Turnpack installed still reaches for its built-in read and edit tools. This
 * flag, documented by Claude Code for server authors, asks for a tool to be loaded with the
 * session instead. Three tools and about 1,200 tokens is a schema small enough to justify it.
 * Other clients ignore the field.
 */
const LOAD_UPFRONT = { "anthropic/alwaysLoad": true };

/**
 * Sent once in the `initialize` result. Clients place it in the model's context, which is how
 * the model learns when these tools beat its built-in ones. The text below is fixed; the only
 * thing ever added to it is one line about the project the server was started in (its check
 * command, or that it has no project), so it is the same on every session in a project and
 * never disturbs prompt caching. No rules files are edited.
 */
export const SERVER_INSTRUCTIONS = [
  "Turnpack folds multi-step file work into single calls.",
  "- Need 2+ files, or a search plus the code around what it finds? Call `pack` once (query + context + files + globs + git_status together) instead of separate read/search calls.",
  "- Changing 2+ files, or making any change that must pass a test or typecheck? Call `ship` once with every edit (search/replace `edits`, or one `patch` in apply_patch or unified-diff format) and a `verify` command. If verify fails, all files are restored automatically and you get the failing output: fix the edit and ship again.",
  "- Need a fact about many files (counts, outlines, which files match)? Call `batch` with a short script and return only the summary.",
  "For one small edit to a file you already have open, your normal edit tool is fine.",
].join("\n");

const NO_PROJECT_LINE =
  "This server was not started inside a project: pass `root` (the absolute path of the project directory) on every call.";

/** The instructions for a server with this workspace policy. See SERVER_INSTRUCTIONS. */
export function serverInstructions(policy?: RootPolicy, clientReportsRoots = false): string {
  if (!policy) return SERVER_INSTRUCTIONS;
  if (policy.source === "none") {
    // A client that reports its folders is about to supply one.
    return clientReportsRoots ? SERVER_INSTRUCTIONS : `${SERVER_INSTRUCTIONS}\n${NO_PROJECT_LINE}`;
  }
  const root = policy.roots[0];
  let checks = "";
  try {
    checks = root ? describeChecks(detectChecks(root)) : "";
  } catch {
    checks = "";
  }
  return checks ? `${SERVER_INSTRUCTIONS}\n${checks} Use it as ship's verify.` : SERVER_INSTRUCTIONS;
}

const ROOT_IN_WORKSPACE = "Subdirectory of the workspace to work in (default: the workspace root).";
const ROOT_REQUIRED =
  "Absolute path of the project directory. Required on every call: this server was not told which project is open.";

// The schemas use only `type`, `properties`, `items`, `required` and `description`. Unions
// (`oneOf`, `anyOf`, a list of types) are left out on purpose: several model APIs drop or
// reject them, and a tool whose schema is rewritten in transit is a tool that gets called
// wrongly. The tools still accept the richer shapes when a model sends them.
export const TOOLS: McpToolDefinition[] = [
  {
    name: "pack",
    description:
      "Read and search the project in ONE call instead of several: a regex search (with the lines around each hit if you ask), any number of files (whole, a line range, or one function), glob listings and git status together. Use it whenever you need 2+ files, or a search plus what it finds. Output is size-capped; .env files and keys are redacted.",
    annotations: { title: "Pack context", readOnlyHint: true, openWorldHint: false },
    _meta: LOAD_UPFRONT,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Regex to search the repo for (plain text with literal: true)." },
        literal: { type: "boolean", description: "Treat query as plain text." },
        context: {
          type: "integer",
          description: "Lines of code to show around each search hit (0-30), so the matches need no second read.",
        },
        files: {
          type: "array",
          items: { type: "string" },
          description:
            "Files to read: 'src/app.ts' (whole), 'src/app.ts:10-80' (lines), 'src/app.ts#handleLogin' (one function or class), 'src/app.ts#' (outline).",
        },
        globs: { type: "array", items: { type: "string" }, description: "Globs to list, e.g. 'src/**/*.ts'." },
        git_status: { type: "boolean", description: "Include git status." },
        max_matches: { type: "integer", description: "Search hit cap (default 80, max 300)." },
        max_bytes: { type: "integer", description: "Inline size cap, 4000-44000; overflow goes to files." },
        inline_only: { type: "boolean", description: "Never spill to files." },
        allow_secrets: { type: "boolean", description: "Show secret files. Only when the user asked." },
        root: { type: "string", description: ROOT_IN_WORKSPACE },
      },
    },
  },
  {
    name: "ship",
    description:
      "Edit files and run the tests in ONE call. Applies search/replace edits or a patch, new files, moves and deletes across any number of files, then runs your verify command(s). If verify fails, every file is restored byte-for-byte and you get the failing output. If an edit cannot be applied, nothing is written and the reply shows the nearest text. Prefer it over separate edit calls (or apply_patch) plus a test run whenever a change spans files or must pass a check.",
    annotations: {
      title: "Ship verified edits",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    _meta: LOAD_UPFRONT,
    inputSchema: {
      type: "object",
      properties: {
        edits: {
          type: "array",
          description:
            "Search/replace edits. search is text copied from the file and must identify one place, unless replace_all. Several edits may name the same file.",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              search: { type: "string" },
              replace: { type: "string" },
              replace_all: { type: "boolean" },
            },
            required: ["path", "search", "replace"],
          },
        },
        patch: {
          type: "string",
          description:
            "Instead of edits: one patch for any number of files, in apply_patch format (*** Begin Patch / *** Update File: path / @@ / lines starting with space, - or +) or as a unified diff.",
        },
        writes: {
          type: "array",
          description: "Create or fully replace files.",
          items: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" } },
            required: ["path", "content"],
          },
        },
        moves: {
          type: "array",
          description: "Rename or move files. Edits in the same call use the new path.",
          items: {
            type: "object",
            properties: { from: { type: "string" }, to: { type: "string" } },
            required: ["from", "to"],
          },
        },
        deletes: { type: "array", items: { type: "string" }, description: "Files to delete." },
        verify: {
          type: "array",
          items: { type: "string" },
          description: 'Commands that must each exit 0, run in order, e.g. ["npm test"]. Omit only for untestable changes.',
        },
        timeout_ms: { type: "integer", description: "Per-command verify timeout (default 60000, max 300000)." },
        rollback_on_fail: { type: "boolean", description: "Restore files if verify fails (default true)." },
        allow_secrets: { type: "boolean", description: "Allow changing secret files." },
        root: { type: "string", description: ROOT_IN_WORKSPACE },
      },
    },
  },
  {
    name: "batch",
    description:
      "Run a short read-only JS script over the repo to answer a question that would otherwise take many reads (count usages, outline every file, filter files by content). The script gets ctx.files(glob), ctx.read(path, start, end), ctx.outline(path), await ctx.grep(pattern), await ctx.gitStatus(). Return a compact summary, not raw file contents. It cannot write files or run commands.",
    annotations: { title: "Batch read-only script", readOnlyHint: true, openWorldHint: false },
    _meta: LOAD_UPFRONT,
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "JS body (may use await/return) or async (ctx) => ..." },
        timeout_ms: { type: "integer", description: "Time limit in ms (default 5000, max 30000)." },
        allow_secrets: { type: "boolean", description: "Include secret files. Only when the user asked." },
        root: { type: "string", description: ROOT_IN_WORKSPACE },
      },
      required: ["code"],
    },
  },
];

/**
 * The tool list for a server in this state. Two things can change it:
 * - `batch` stops being read-only the moment the operator enables ctx.exec, and says so.
 * - A server with no workspace needs `root` on every call, so there it is required.
 */
export function listTools(policy?: RootPolicy): McpToolDefinition[] {
  const execEnabled = process.env.TURNPACK_ALLOW_EXEC === "1";
  const needsRoot = policy?.source === "none";
  if (!execEnabled && !needsRoot) return TOOLS;
  return TOOLS.map((tool) => {
    let next: McpToolDefinition = tool;
    if (execEnabled && tool.name === "batch") {
      next = {
        ...next,
        description: next.description.replace(
          "It cannot write files or run commands.",
          "ctx.exec(command) is enabled on this server and runs shell commands.",
        ),
        annotations: { ...next.annotations, readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      };
    }
    if (needsRoot) {
      const schema = next.inputSchema as { properties: Record<string, unknown>; required?: string[] };
      next = {
        ...next,
        inputSchema: {
          ...schema,
          properties: { ...schema.properties, root: { type: "string", description: ROOT_REQUIRED } },
          required: [...(schema.required ?? []), "root"],
        },
      };
    }
    return next;
  });
}

/**
 * `TURNPACK_LOG=<file>` makes the server append one line per tool call: the time, the tool, how
 * long it took, whether it succeeded, and the size of the reply. It answers "is my agent using
 * these tools, or still reading files one at a time?" without watching a session. It is off
 * unless set, it stays on this machine, and it never records arguments, paths or file contents.
 */
function logCall(tool: string, startedAt: number, text: string, isError: boolean): void {
  const logPath = process.env.TURNPACK_LOG?.trim();
  if (!logPath) return;
  const status = tool === "ship" ? /^[A-Z_]{6,}/.exec(text)?.[0] : undefined;
  const line = JSON.stringify({
    t: new Date().toISOString(),
    tool,
    ms: Math.round(performance.now() - startedAt),
    ok: !isError,
    bytes: Buffer.byteLength(text, "utf8"),
    ...(status ? { status } : {}),
  });
  fs.appendFile(logPath, `${line}\n`, () => {
    // A log that cannot be written must never get in the way of the call.
  });
}

export function resolveClientContext(clientNameRaw?: string): ClientContext {
  const overrideName = process.env.TURNPACK_CLIENT?.trim() || clientNameRaw?.trim() || "default";
  const lower = overrideName.toLowerCase();

  let maxInlineBytes = 12000;
  let readToolHint = "Read";

  if (lower.includes("claude")) {
    maxInlineBytes = 24000;
    readToolHint = "Read";
  } else if (lower.includes("codex")) {
    maxInlineBytes = 32000;
    readToolHint = "fs/read";
  } else if (lower.includes("omp") || lower.includes("oh-my-pi") || lower.includes("pi-")) {
    maxInlineBytes = 32000;
    readToolHint = "read";
  } else if (
    lower.includes("cursor") ||
    lower.includes("gemini") ||
    lower.includes("opencode") ||
    lower.includes("grok")
  ) {
    maxInlineBytes = 20000;
    readToolHint = lower.includes("gemini") ? "read_file" : "Read";
  }

  const envCap = Number(process.env.TURNPACK_MAX_INLINE_BYTES || "");
  if (Number.isFinite(envCap) && envCap > 0) {
    maxInlineBytes = Math.min(44000, Math.max(4000, Math.round(envCap)));
  }

  return {
    clientName: overrideName,
    maxInlineBytes,
    readToolHint,
  };
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

type Framing = "ndjson" | "content-length";

// Versions whose tools surface this server implements. A client asking for anything else is
// offered FALLBACK_PROTOCOL, as the specification's version negotiation requires.
const SUPPORTED_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const FALLBACK_PROTOCOL = "2025-06-18";
const ROOTS_WAIT_MS = 1500;

export interface McpServerOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  cwd?: string;
}

export function startMcpServer(options: McpServerOptions = {}): void {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;

  let policy: RootPolicy;
  let protocolVersion = "";
  try {
    policy = createRootPolicy(options.cwd);
  } catch (err) {
    process.stderr.write(`turnpack: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
    return;
  }

  let detectedClient = resolveClientContext();
  let responseFraming: Framing = "ndjson";
  let rxBuffer = Buffer.alloc(0);
  let clientHasRoots = false;
  let rootsRequestSeq = 0;
  let pendingRootsId: string | null = null;
  let rootsSettled: Promise<void> = Promise.resolve();
  let settleRoots: () => void = () => {};
  // `ship` calls run one at a time: two interleaved multi-file writes would defeat the
  // all-or-nothing guarantee each of them makes.
  let shipQueue: Promise<unknown> = Promise.resolve();

  const write = (payload: Record<string, unknown>): void => {
    const json = JSON.stringify(payload);
    if (responseFraming === "content-length") {
      output.write(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`);
    } else {
      output.write(`${json}\n`);
    }
  };

  const reply = (id: string | number, result: Record<string, unknown>): void => {
    write({ jsonrpc: "2.0", id, result });
  };
  const replyError = (id: string | number | null, code: number, message: string): void => {
    write({ jsonrpc: "2.0", id, error: { code, message } });
  };
  const toolText = (id: string | number, text: string, isError: boolean): void => {
    reply(id, { content: [{ type: "text", text }], isError });
  };

  const requestRoots = (): void => {
    if (!clientHasRoots || policy.source === "env") return;
    rootsRequestSeq += 1;
    pendingRootsId = `turnpack-roots-${rootsRequestSeq}`;
    rootsSettled = new Promise((resolve) => {
      const timer = setTimeout(resolve, ROOTS_WAIT_MS);
      settleRoots = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    write({ jsonrpc: "2.0", id: pendingRootsId, method: "roots/list" });
  };

  const handleResponse = (msg: JsonRpcMessage): void => {
    if (msg.id !== pendingRootsId) return;
    pendingRootsId = null;
    if (isRecord(msg.result)) {
      policy = applyClientRoots(policy, msg.result.roots);
    }
    settleRoots();
  };

  const handleNotification = (msg: JsonRpcMessage): void => {
    if (msg.method === "notifications/initialized" || msg.method === "notifications/roots/list_changed") {
      requestRoots();
    }
  };

  const callTool = async (id: string | number, params: Record<string, unknown>): Promise<void> => {
    const toolName = typeof params.name === "string" ? params.name : "";
    if (toolName !== "pack" && toolName !== "ship" && toolName !== "batch") {
      replyError(id, -32602, `Unknown tool: ${toolName}`);
      return;
    }
    const startedAt = performance.now();
    try {
      await runTool(id, toolName, params, startedAt);
    } catch (err) {
      // Tool failures are results the model can read and react to, not protocol errors.
      const text = `Error: ${err instanceof Error ? err.message : String(err)}`;
      logCall(toolName, startedAt, text, true);
      toolText(id, text, true);
    }
  };

  const runTool = async (
    id: string | number,
    toolName: "pack" | "ship" | "batch",
    params: Record<string, unknown>,
    startedAt: number,
  ): Promise<void> => {
    const toolText = (callId: string | number, text: string, isError: boolean): void => {
      logCall(toolName, startedAt, text, isError);
      reply(callId, { content: [{ type: "text", text }], isError });
    };
    const rawArgs = params.arguments ?? {};
    if (!isRecord(rawArgs)) {
      toolText(id, `Error: ${toolName} arguments must be a JSON object`, true);
      return;
    }

    // Give a just-requested roots/list a moment to answer, so the first call of a session is
    // already confined to the folders the client named.
    await rootsSettled;

    // The directory is decided here, from the policy. Whatever name the call used for it is
    // replaced by the one answer, so no alias can reach a tool unchecked.
    const root = resolveToolRoot(policy, pick(rawArgs, ROOT_KEYS));
    const args: Record<string, unknown> = { ...rawArgs };
    for (const key of ROOT_KEYS) delete args[key];
    args.root = root;

    if (toolName === "pack") {
      toolText(id, await runPack(args as PackArgs, detectedClient), false);
      return;
    }

    if (toolName === "ship") {
      // A verify command can run for minutes. Clients that asked for progress get a line when
      // each command starts and a heartbeat while it runs, so the wait is visibly alive.
      const meta = isRecord(params._meta) ? params._meta : {};
      const token = meta.progressToken;
      const wantsProgress = typeof token === "string" || typeof token === "number";
      let stage = "checking the edits";
      let stageStartedAt = Date.now();
      let ticks = 0;
      const report = (message: string): void => {
        if (!wantsProgress) return;
        ticks += 1;
        const progress: Record<string, unknown> = { progressToken: token, progress: ticks };
        // `message` joined the protocol in 2025-03-26; older clients get the bare counter.
        if (protocolVersion !== "2024-11-05") progress.message = message;
        write({ jsonrpc: "2.0", method: "notifications/progress", params: progress });
      };
      const workspaceRoots = configScope(policy, root);
      const run = shipQueue.then(async () => {
        const beat = wantsProgress
          ? setInterval(() => report(`${stage} (${Math.round((Date.now() - stageStartedAt) / 1000)}s)`), 5000)
          : undefined;
        try {
          return await runShip(args as ShipArgs, {
            workspaceRoots,
            onProgress: (message) => {
              stage = message;
              stageStartedAt = Date.now();
              report(message);
            },
          });
        } finally {
          clearInterval(beat);
        }
      });
      shipQueue = run.catch(() => undefined);
      const res = await run;
      toolText(id, res.summary, res.status !== "SHIPPED_AND_VERIFIED" && res.status !== "APPLIED_NO_VERIFY");
      return;
    }

    toolText(id, await runBatch(args as unknown as BatchArgs), false);
  };

  const handleRequest = async (id: string | number, msg: JsonRpcMessage): Promise<void> => {
    const params = isRecord(msg.params) ? msg.params : {};
    try {
      switch (msg.method) {
        case "initialize": {
          const clientInfo = isRecord(params.clientInfo) ? params.clientInfo : {};
          const clientName = typeof clientInfo.name === "string" ? clientInfo.name : "";
          detectedClient = resolveClientContext(clientName || undefined);
          // CLAUDE_PROJECT_DIR names the project of the Claude Code session that set it. Any
          // other app started from that session's terminal inherits the variable, and for that
          // app it names the wrong folder. So it is believed only when Claude is the client.
          if (policy.source === "project" && !/claude/i.test(clientName)) {
            policy = createRootPolicy(options.cwd, { ignoreProjectEnv: true });
          }
          const capabilities = isRecord(params.capabilities) ? params.capabilities : {};
          clientHasRoots = capabilities.roots !== undefined && capabilities.roots !== null;
          const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
          protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : FALLBACK_PROTOCOL;
          reply(id, {
            protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "turnpack", version: VERSION },
            instructions: serverInstructions(policy, clientHasRoots),
          });
          return;
        }
        case "ping":
          reply(id, {});
          return;
        case "tools/list":
          // With no workspace yet, wait for the folders the client was just asked for: whether
          // `root` is required depends on the answer.
          if (policy.source === "none" && clientHasRoots) await rootsSettled;
          reply(id, { tools: listTools(policy) });
          return;
        case "resources/list":
          reply(id, { resources: [] });
          return;
        case "resources/templates/list":
          reply(id, { resourceTemplates: [] });
          return;
        case "prompts/list":
          reply(id, { prompts: [] });
          return;
        case "tools/call":
          await callTool(id, params);
          return;
        default:
          replyError(id, -32601, `Method not found: ${String(msg.method ?? "")}`);
      }
    } catch (err) {
      // Tool failures are results the model can read and react to, not protocol errors.
      toolText(id, `Error: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  };

  const dispatch = (parsed: unknown): void => {
    if (Array.isArray(parsed)) {
      for (const item of parsed) dispatch(item);
      return;
    }
    if (!isRecord(parsed)) {
      replyError(null, -32600, "Invalid Request");
      return;
    }
    const msg = parsed as JsonRpcMessage;
    const hasId = typeof msg.id === "string" || typeof msg.id === "number";
    if (typeof msg.method !== "string") {
      if (hasId) handleResponse(msg);
      return;
    }
    if (!hasId) {
      handleNotification(msg);
      return;
    }
    void handleRequest(msg.id as string | number, msg);
  };

  const dispatchJson = (text: string): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      replyError(null, -32700, "Parse error");
      return;
    }
    dispatch(parsed);
  };

  const drainBuffer = (): void => {
    while (rxBuffer.length > 0) {
      const head = rxBuffer.subarray(0, Math.min(rxBuffer.length, 64)).toString("utf8");
      if (/^\s*Content-Length:/i.test(head)) {
        let sepIdx = rxBuffer.indexOf("\r\n\r\n");
        let sepLen = 4;
        if (sepIdx === -1) {
          sepIdx = rxBuffer.indexOf("\n\n");
          sepLen = 2;
        }
        if (sepIdx === -1) break;

        const headerText = rxBuffer.subarray(0, sepIdx).toString("utf8");
        const lenMatch = /Content-Length:\s*(\d+)/i.exec(headerText);
        if (!lenMatch || !lenMatch[1]) {
          rxBuffer = rxBuffer.subarray(sepIdx + sepLen);
          continue;
        }
        const byteLen = Number(lenMatch[1]);
        const bodyStart = sepIdx + sepLen;
        if (rxBuffer.length < bodyStart + byteLen) break;

        responseFraming = "content-length";
        const bodyJson = rxBuffer.subarray(bodyStart, bodyStart + byteLen).toString("utf8");
        rxBuffer = rxBuffer.subarray(bodyStart + byteLen);
        dispatchJson(bodyJson);
        continue;
      }

      const nlIdx = rxBuffer.indexOf("\n");
      if (nlIdx === -1) break;
      const line = rxBuffer.subarray(0, nlIdx).toString("utf8").trim();
      rxBuffer = rxBuffer.subarray(nlIdx + 1);
      if (!line) continue;
      responseFraming = "ndjson";
      dispatchJson(line);
    }
  };

  input.on("data", (chunk: Buffer | string) => {
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    rxBuffer = Buffer.concat([rxBuffer, buf]);
    drainBuffer();
  });

  // The client going away mid-reply is not an error worth a stack trace.
  output.on("error", () => {
    process.exit(0);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startMcpServer();
}
