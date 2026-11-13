import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  nodeVersion: string;
  ripgrepVersion: string | null;
  schemaBytes: number;
  estimatedSchemaTokens: number;
  handshakeMs: number;
  checks: DoctorCheck[];
}

function getCliEntryPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "cli.js");
}

async function probeMcpLoopback(tempDir: string): Promise<{
  toolsBytes: number;
  toolNames: string[];
  packRedacted: boolean;
  handshakeMs: number;
}> {
  const entry = getCliEntryPath();
  const t0 = performance.now();

  return await new Promise((resolveProbe, rejectProbe) => {
    const child = spawn(process.execPath, [entry, "serve"], {
      cwd: os.tmpdir(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    const responses = new Map<number, Record<string, unknown>>();
    const timer = setTimeout(() => {
      child.kill();
      rejectProbe(new Error("MCP loopback timed out after 5000ms"));
    }, 5000);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      let idx: number;
      while ((idx = stdout.indexOf("\n")) !== -1) {
        const line = stdout.slice(0, idx).trim();
        stdout = stdout.slice(idx + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          const id = typeof parsed.id === "number" ? parsed.id : -1;
          if (id >= 0) {
            responses.set(id, parsed);
          }
          if (responses.has(1) && responses.has(2) && responses.has(3)) {
            clearTimeout(timer);
            const handshakeMs = Math.round(performance.now() - t0);

            const toolsResp = responses.get(2)?.result as
              | { tools?: Array<{ name?: string }> }
              | undefined;
            const tools = toolsResp?.tools ?? [];
            const toolsBytes = Buffer.byteLength(JSON.stringify(tools), "utf8");
            const toolNames = tools.map((t) => String(t.name ?? ""));

            const packResp = responses.get(3)?.result as
              | { content?: Array<{ text?: string }> }
              | undefined;
            const packText = packResp?.content?.[0]?.text ?? "";
            const packRedacted =
              packText.includes("REDACTED SECRET FILE") && !packText.includes("SECRET_VAL");

            const payload = {
              toolsBytes,
              toolNames,
              packRedacted,
              handshakeMs,
            };
            child.once("close", () => resolveProbe(payload));
            child.stdin.end();
            child.kill();
          }
        } catch {
          // Ignore partial line.
        }
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      rejectProbe(err);
    });

    const req1 = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", clientInfo: { name: "claude-code" } },
    });
    const req2 = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const req3 = JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "pack", arguments: { root: tempDir, files: [".env"] } },
    });
    child.stdin.write(`${req1}\n${req2}\n${req3}\n`);
  });
}

export async function runDoctor(options: { json?: boolean } = {}): Promise<DoctorReport> {
  const majorNode = Number(process.versions.node.split(".")[0] ?? "0");
  const nodeOk = majorNode >= 22;
  const checks: DoctorCheck[] = [
    {
      name: "Node.js >= 22",
      ok: nodeOk,
      detail: `v${process.versions.node}`,
    },
  ];

  let rgVersion: string | null = null;
  try {
    const { stdout } = await execFileAsync("rg", ["--version"], { timeout: 3000 });
    rgVersion = stdout.split(/\r?\n/)[0]?.trim() || "installed";
  } catch {
    rgVersion = null;
  }
  checks.push({
    name: "ripgrep fast search",
    ok: true,
    detail: rgVersion ? rgVersion : "not found (using built-in Node search fallback)",
  });

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "turnpack-doc-"));
  let schemaBytes = 0;
  let handshakeMs = 0;

  try {
    fs.writeFileSync(path.join(tempDir, ".env"), "TOKEN=SECRET_VAL\n");
    const probe = await probeMcpLoopback(tempDir);
    schemaBytes = probe.toolsBytes;
    handshakeMs = probe.handshakeMs;

    const schemaTokens = Math.ceil(schemaBytes / 4);
    checks.push({
      name: "MCP stdio handshake + tools",
      ok: probe.toolNames.join(",") === "pack,ship,batch",
      detail: `${probe.toolNames.join(", ")} (${handshakeMs}ms)`,
    });
    checks.push({
      name: "Compact schema budget (< 1,500 tokens)",
      ok: schemaTokens < 1500,
      detail: `${schemaBytes} bytes (~${schemaTokens} tokens)`,
    });
    checks.push({
      name: "Default .env secret shield",
      ok: probe.packRedacted,
      detail: probe.packRedacted ? "active (blocked .env read)" : "failed",
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }

  const report: DoctorReport = {
    ok: checks.every((c) => c.ok),
    nodeVersion: `v${process.versions.node}`,
    ripgrepVersion: rgVersion,
    schemaBytes,
    estimatedSchemaTokens: Math.ceil(schemaBytes / 4),
    handshakeMs,
    checks,
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write("\nturnpack doctor\n");
    process.stdout.write("────────────────────────────────────────────────────────────\n");
    for (const check of report.checks) {
      const tag = check.ok ? "OK  " : "FAIL";
      process.stdout.write(`  [${tag}] ${check.name.padEnd(34)} ${check.detail}\n`);
    }
    process.stdout.write("────────────────────────────────────────────────────────────\n\n");
  }

  return report;
}
