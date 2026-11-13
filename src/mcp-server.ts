import { pathToFileURL } from "node:url";
import { runBatch, type BatchArgs } from "./tools/batch.js";
import { runPack, type ClientContext, type PackArgs } from "./tools/pack.js";
import { runShip, type ShipArgs } from "./tools/ship.js";

export interface McpToolDefinition {
  name: "pack" | "ship" | "batch";
  description: string;
  inputSchema: Record<string, unknown>;
}

export const TOOLS: McpToolDefinition[] = [
  {
    name: "pack",
    description:
      "Search, slice line ranges or symbols, list globs, and check git status in one bounded call. Redacts .env and private keys by default.",
    inputSchema: {
      type: "object",
      properties: {
        root: { type: "string", description: "Workspace root directory (defaults to cwd)." },
        query: { type: "string", description: "Regex or literal search pattern across repo files." },
        literal: { type: "boolean", description: "Treat query as plain text instead of regex." },
        files: {
          type: "array",
          description: "Files or slices ('src/app.ts:1-80' or {path, start_line, end_line, symbol}).",
          items: {
            oneOf: [
              { type: "string" },
              {
                type: "object",
                properties: {
                  path: { type: "string" },
                  start_line: { type: "integer" },
                  end_line: { type: "integer" },
                  symbol: { type: "string" },
                },
                required: ["path"],
              },
            ],
          },
        },
        globs: { type: "array", items: { type: "string" }, description: "File glob patterns to list." },
        git_status: { type: "boolean", description: "Include git status summary." },
        inline_only: { type: "boolean", description: "Keep full output inline instead of spilling to shards." },
        max_bytes: { type: "integer", description: "Inline ceiling [4000..44000] before spilling shards." },
        allow_secrets: { type: "boolean", description: "Set true only if intentionally inspecting secret files." },
      },
    },
  },
  {
    name: "ship",
    description:
      "Validate and apply multi-file writes/edits, run verify command(s), and restore byte-exact preimage snapshots automatically if verification fails.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Workspace root directory." },
        writes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              content: { type: "string" },
              expected_sha256: { type: "string" },
            },
            required: ["path", "content"],
          },
        },
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              search: { type: "string" },
              replace: { type: "string" },
              replace_all: { type: "boolean" },
              expected_mtime_ms: { type: "number" },
              changes: {
                type: "array",
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
        verify: {
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          description: "Command(s) to verify edits (e.g. 'npm test').",
        },
        timeout_ms: { type: "integer", description: "Per-command verify timeout (default 60000)." },
        rollback_on_fail: { type: "boolean", description: "Restore snapshots if verify fails (default true)." },
        rollback_on_verify_fail: { type: "boolean", description: "Alias for rollback_on_fail." },
        allow_secrets: { type: "boolean", description: "Allow editing secret files (default false)." },
      },
    },
  },
  {
    name: "batch",
    description:
      "Execute a short read-only JS script with ctx.files, ctx.read, ctx.grep, ctx.outline, and ctx.gitStatus to analyze multiple files in one turn.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Workspace root directory." },
        code: { type: "string", description: "JS body or async (ctx) => ... returning a summary." },
        timeout_ms: { type: "integer", description: "Execution timeout in ms (default 5000)." },
        allow_secrets: { type: "boolean", description: "Include secret files (default false)." },
      },
      required: ["code"],
    },
  },
];

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

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

type Framing = "ndjson" | "content-length";

export function startMcpServer(): void {
  let detectedClient = resolveClientContext();
  let responseFraming: Framing = "ndjson";
  let rxBuffer = Buffer.alloc(0);

  const writeResponse = (payload: Record<string, unknown>): void => {
    const json = JSON.stringify(payload);
    if (responseFraming === "content-length") {
      const len = Buffer.byteLength(json, "utf8");
      process.stdout.write(`Content-Length: ${len}\r\n\r\n${json}`);
    } else {
      process.stdout.write(`${json}\n`);
    }
  };

  const handleMessage = async (msg: JsonRpcRequest): Promise<void> => {
    const { id, method, params } = msg;
    if (id === undefined || id === null) {
      return;
    }

    try {
      if (method === "initialize") {
        const clientInfo = params?.clientInfo as { name?: unknown } | undefined;
        const clientName = typeof clientInfo?.name === "string" ? clientInfo.name : undefined;
        detectedClient = resolveClientContext(clientName);
        const requestedProto =
          typeof params?.protocolVersion === "string" ? params.protocolVersion : "2024-11-05";

        writeResponse({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: requestedProto,
            capabilities: { tools: {} },
            serverInfo: { name: "turnpack", version: "0.1.0" },
          },
        });
        return;
      }

      if (method === "ping") {
        writeResponse({ jsonrpc: "2.0", id, result: {} });
        return;
      }

      if (method === "tools/list") {
        writeResponse({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
        return;
      }

      if (method === "resources/list") {
        writeResponse({ jsonrpc: "2.0", id, result: { resources: [] } });
        return;
      }

      if (method === "prompts/list") {
        writeResponse({ jsonrpc: "2.0", id, result: { prompts: [] } });
        return;
      }

      if (method === "tools/call") {
        const toolName = typeof params?.name === "string" ? params.name : "";
        const rawArgs = (params?.arguments ?? {}) as Record<string, unknown>;

        if (toolName === "pack") {
          const text = await runPack(rawArgs as unknown as PackArgs, detectedClient);
          writeResponse({
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text }], isError: false },
          });
          return;
        }

        if (toolName === "ship") {
          const res = await runShip(rawArgs as unknown as ShipArgs);
          const isError =
            res.status !== "SHIPPED_AND_VERIFIED" && res.status !== "APPLIED_NO_VERIFY";
          writeResponse({
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: res.summary }], isError },
          });
          return;
        }

        if (toolName === "batch") {
          const text = await runBatch(rawArgs as unknown as BatchArgs);
          writeResponse({
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text }], isError: false },
          });
          return;
        }

        writeResponse({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Unknown tool: ${toolName}` },
        });
        return;
      }

      writeResponse({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${String(method ?? "")}` },
      });
    } catch (err) {
      writeResponse({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        },
      });
    }
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
        try {
          const msg = JSON.parse(bodyJson) as JsonRpcRequest;
          void handleMessage(msg);
        } catch {
          // Ignore malformed JSON frames cleanly.
        }
        continue;
      }

      const nlIdx = rxBuffer.indexOf("\n");
      if (nlIdx === -1) break;
      const line = rxBuffer.subarray(0, nlIdx).toString("utf8").trim();
      rxBuffer = rxBuffer.subarray(nlIdx + 1);
      if (!line) continue;
      responseFraming = "ndjson";
      try {
        const msg = JSON.parse(line) as JsonRpcRequest;
        void handleMessage(msg);
      } catch {
        // Ignore malformed NDJSON lines cleanly.
      }
    }
  };

  process.stdin.on("data", (chunk: Buffer | string) => {
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    rxBuffer = Buffer.concat([rxBuffer, buf]);
    drainBuffer();
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startMcpServer();
}
