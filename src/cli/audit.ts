import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface AuditFinding {
  client: string;
  filePath: string;
  exists: boolean;
  serverCount: number;
  hasTurnpack: boolean;
  notes: string[];
}

export interface AuditReport {
  homeDir: string;
  findings: AuditFinding[];
  totalConfiguredServers: number;
}

function auditJsonFile(
  client: string,
  filePath: string,
  containerKey: "mcpServers" | "mcp",
): AuditFinding {
  if (!fs.existsSync(filePath)) {
    return { client, filePath, exists: false, serverCount: 0, hasTurnpack: false, notes: [] };
  }
  const notes: string[] = [];
  let serverCount = 0;
  let hasTurnpack = false;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    const container = parsed[containerKey];
    if (container && typeof container === "object" && !Array.isArray(container)) {
      const keys = Object.keys(container);
      serverCount = keys.length;
      hasTurnpack = keys.includes("turnpack");
      if (serverCount > 8) {
        notes.push(`${serverCount} MCP servers registered — high tool-schema token overhead`);
      }
    }
  } catch (err) {
    notes.push(`invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { client, filePath, exists: true, serverCount, hasTurnpack, notes };
}

function auditTomlFile(client: string, filePath: string): AuditFinding {
  if (!fs.existsSync(filePath)) {
    return { client, filePath, exists: false, serverCount: 0, hasTurnpack: false, notes: [] };
  }
  const text = fs.readFileSync(filePath, "utf8");
  const matches = [...text.matchAll(/^\[mcp_servers\.([^\]]+)\]/gm)];
  const serverCount = matches.length;
  const hasTurnpack = matches.some((m) => m[1]?.trim() === "turnpack");
  const notes: string[] = [];
  if (serverCount > 8) {
    notes.push(`${serverCount} MCP servers registered — high tool-schema token overhead`);
  }
  return { client, filePath, exists: true, serverCount, hasTurnpack, notes };
}

export function runAudit(argv: string[]): AuditReport {
  let homeDir = os.homedir();
  let asJson = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--home" && next) {
      homeDir = path.resolve(next);
      i += 1;
    } else if (arg === "--json") {
      asJson = true;
    }
  }

  const findings: AuditFinding[] = [
    auditJsonFile("Claude Code", path.join(homeDir, ".claude.json"), "mcpServers"),
    auditTomlFile("Codex CLI", path.join(homeDir, ".codex", "config.toml")),
    auditJsonFile("OMP", path.join(homeDir, ".omp", "agent", "mcp.json"), "mcpServers"),
    auditJsonFile("Cursor", path.join(homeDir, ".cursor", "mcp.json"), "mcpServers"),
    auditJsonFile("Gemini CLI", path.join(homeDir, ".gemini", "settings.json"), "mcpServers"),
    auditJsonFile("OpenCode", path.join(homeDir, ".config", "opencode", "opencode.json"), "mcp"),
    auditTomlFile("Grok CLI", path.join(homeDir, ".grok", "config.toml")),
  ];

  const totalConfiguredServers = findings.reduce((sum, f) => sum + f.serverCount, 0);
  const report: AuditReport = { homeDir, findings, totalConfiguredServers };

  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report;
  }

  process.stdout.write(`\nturnpack audit (read-only scan of ${homeDir})\n`);
  process.stdout.write("─────────────────────────────────────────────────────────────────\n");
  for (const item of findings) {
    if (!item.exists) continue;
    const tp = item.hasTurnpack ? "turnpack=YES" : "turnpack=no ";
    process.stdout.write(
      `  ${item.client.padEnd(13)} ${String(item.serverCount).padStart(2)} MCP server(s)  ${tp}  ${item.filePath}\n`,
    );
    for (const note of item.notes) {
      process.stdout.write(`    ! ${note}\n`);
    }
  }
  process.stdout.write("─────────────────────────────────────────────────────────────────\n\n");
  return report;
}
