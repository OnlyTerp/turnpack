import { pathToFileURL } from "node:url";
import { applyClientRoots, createRootPolicy, resolveToolRoot, type RootPolicy } from "./roots.js";
import { runBatch, type BatchArgs } from "./tools/batch.js";
import { runPack, type ClientContext, type PackArgs } from "./tools/pack.js";
import { runShip, type ShipArgs } from "./tools/ship.js";
import { isRecord } from "./validate.js";
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
}

/**
 * Sent once in the `initialize` result. Clients place it in the model's context, which is how
 * the model learns when these tools beat its built-in ones. It is static text, so it never
 * disturbs prompt caching, and it is the only steering Turnpack does: no rules files are edited.
 */
export const SERVER_INSTRUCTIONS = [
  "Turnpack folds multi-step file work into single calls.",
  "- Need 2+ files, or a search plus the files it finds? Call `pack` once (query + files + globs + git_status together) instead of separate read/search calls.",
  "- Changing 2+ files, or making any change that must pass a test or typecheck? Call `ship` once with every edit and a `verify` command. If verify fails, all files are restored automatically and you get the failing output: fix the edit and ship again.",
  "- Need a fact about many files (counts, outlines, which files match)? Call `batch` with a short script and return only the summary.",
  "For one small edit to a file you already have open, your normal edit tool is fine.",
].join("\n");

export const TOOLS: McpToolDefinition[] = [
  {
    name: "pack",
    description:
      "Gather context in ONE call instead of several read/search calls: regex search, whole files, line ranges, symbols, glob listings and git status together. Use whenever you need 2+ files, or a search plus files. Output is size-capped; .env files and keys are redacted.",
    annotations: { title: "Pack context", readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Regex (or literal) to search for across the repo." },
        literal: { type: "boolean", description: "Treat query as plain text." },
        files: {
          type: "array",
          description: "Files to read: 'src/app.ts', 'src/app.ts:10-80', or {path, start_line, end_line, symbol}.",
          items: {
            oneOf: [
              { type: "string" },
              {
                type: "object",
                properties: {
                  path: { type: "string" },
                  start_line: { type: "integer" },
                  end_line: { type: "integer" },
                  symbol: { type: "string", description: "Function/class name to slice out." },
                },
                required: ["path"],
              },
            ],
          },
        },
        globs: { type: "array", items: { type: "string" }, description: "Globs to list, e.g. 'src/**/*.ts'." },
        git_status: { type: "boolean", description: "Include git status." },
        max_matches: { type: "integer", description: "Search hit cap (default 80, max 300)." },
        max_bytes: { type: "integer", description: "Inline size cap, 4000-44000; overflow goes to files." },
        inline_only: { type: "boolean", description: "Never spill to files." },
        allow_secrets: { type: "boolean", description: "Show secret files. Only when the user asked." },
        root: { type: "string", description: "Subdirectory of the workspace (default: workspace root)." },
      },
    },
  },
  {
    name: "ship",
    description:
      "Apply a multi-file change and test it in ONE call. All edits are validated first (nothing is written if any anchor is missing or ambiguous), then the verify command(s) run. If verify fails, every file is restored byte-for-byte and the failing output is returned. Prefer over separate edit calls plus a test run whenever a change spans files or must pass a check.",
    annotations: {
      title: "Ship verified edits",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        edits: {
          type: "array",
          description: "Exact search/replace edits. search must match once unless replace_all.",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              search: { type: "string" },
              replace: { type: "string" },
              replace_all: { type: "boolean" },
              changes: {
                type: "array",
                description: "Several replacements in this file, applied in order.",
                items: {
                  type: "object",
                  properties: {
                    search: { type: "string" },
                    replace: { type: "string" },
                    replace_all: { type: "boolean" },
                  },
                  required: ["search", "replace"],
                },
              },
            },
            required: ["path"],
          },
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
        deletes: { type: "array", items: { type: "string" }, description: "Files to delete." },
        verify: {
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          description: "Command(s) that must exit 0, e.g. 'npm test'. Omit only for untestable changes.",
        },
        timeout_ms: { type: "integer", description: "Per-command verify timeout (default 60000)." },
        rollback_on_fail: { type: "boolean", description: "Restore files if verify fails (default true)." },
        allow_secrets: { type: "boolean", description: "Allow changing secret files." },
        cwd: { type: "string", description: "Subdirectory of the workspace (default: workspace root)." },
      },
    },
  },
  {
    name: "batch",
    description:
      "Run a short read-only JS script over the repo to answer a question that would otherwise take many reads (count usages, outline every file, filter files by content). The script gets ctx.files(glob), ctx.read(path, start, end), ctx.outline(path), await ctx.grep(pattern), await ctx.gitStatus(). Return a compact summary, not raw file contents. It cannot write files or run commands.",
    annotations: { title: "Batch read-only script", readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "JS body (may use await/return) or async (ctx) => ..." },
        timeout_ms: { type: "integer", description: "Time limit in ms (default 5000, max 30000)." },
        allow_secrets: { type: "boolean", description: "Include secret files. Only when the user asked." },
        cwd: { type: "string", description: "Subdirectory of the workspace (default: workspace root)." },
      },
      required: ["code"],
    },
  },
];

/** `batch` stops being read-only the moment the operator enables ctx.exec; say so truthfully. */
export function listTools(): McpToolDefinition[] {
  if (process.env.TURNPACK_ALLOW_EXEC !== "1") return TOOLS;
  return TOOLS.map((tool) =>
    tool.name === "batch"
      ? {
          ...tool,
          description: tool.description.replace(
            "It cannot write files or run commands.",
            "ctx.exec(command) is enabled on this server and runs shell commands.",
          ),
          annotations: { ...tool.annotations, readOnlyHint: false, destructiveHint: true, openWorldHint: true },
        }
      : tool,
  );
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
    const rawArgs = params.arguments ?? {};
    if (!isRecord(rawArgs)) {
      toolText(id, `Error: ${toolName} arguments must be a JSON object`, true);
      return;
    }

    // Give a just-requested roots/list a moment to answer, so the first call of a session is
    // already confined to the folders the client named.
    await rootsSettled;

    if (toolName === "pack") {
      const root = resolveToolRoot(policy, rawArgs.root);
      const text = await runPack({ ...rawArgs, root } as PackArgs, detectedClient);
      toolText(id, text, false);
      return;
    }

    if (toolName === "ship") {
      const cwd = resolveToolRoot(policy, rawArgs.cwd);
      const run = shipQueue.then(() => runShip({ ...rawArgs, cwd } as ShipArgs));
      shipQueue = run.catch(() => undefined);
      const res = await run;
      toolText(id, res.summary, res.status !== "SHIPPED_AND_VERIFIED" && res.status !== "APPLIED_NO_VERIFY");
      return;
    }

    const cwd = resolveToolRoot(policy, rawArgs.cwd);
    const text = await runBatch({ ...rawArgs, cwd } as unknown as BatchArgs);
    toolText(id, text, false);
  };

  const handleRequest = async (id: string | number, msg: JsonRpcMessage): Promise<void> => {
    const params = isRecord(msg.params) ? msg.params : {};
    try {
      switch (msg.method) {
        case "initialize": {
          const clientInfo = isRecord(params.clientInfo) ? params.clientInfo : {};
          detectedClient = resolveClientContext(
            typeof clientInfo.name === "string" ? clientInfo.name : undefined,
          );
          const capabilities = isRecord(params.capabilities) ? params.capabilities : {};
          clientHasRoots = capabilities.roots !== undefined && capabilities.roots !== null;
          const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
          reply(id, {
            protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : FALLBACK_PROTOCOL,
            capabilities: { tools: {} },
            serverInfo: { name: "turnpack", version: VERSION },
            instructions: SERVER_INSTRUCTIONS,
          });
          return;
        }
        case "ping":
          reply(id, {});
          return;
        case "tools/list":
          reply(id, { tools: listTools() });
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
