import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

export interface PlannedFileChange {
  client: string;
  tier: "tier1" | "experimental";
  filePath: string;
  action: "update" | "create" | "remove" | "unchanged";
  preview: string;
  nextContent: string | null;
}

export interface InstallerResult {
  applied: boolean;
  changes: PlannedFileChange[];
}

function getRepoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..");
}

function getOmpExtensionSource(): string {
  const extPath = path.join(getRepoRoot(), "extensions", "omp-turnpack.ts");
  if (fs.existsSync(extPath)) {
    return fs.readFileSync(extPath, "utf8");
  }
  return `export default function turnpackExtension(pi) { pi.on("session_start", (_e, c) => c.ui?.setStatus?.("turnpack", "turnpack ready")); }\n`;
}

function readJsonRecord(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  const text = fs.readFileSync(filePath, "utf8").trim();
  if (!text) return {};
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Expected JSON object in ${filePath}`);
  }
  return parsed as Record<string, unknown>;
}

function upsertJsonMcp(
  filePath: string,
  containerKey: "mcpServers" | "mcp",
  entryBuilder: () => Record<string, unknown>,
  mode: "init" | "uninstall",
): { action: PlannedFileChange["action"]; nextContent: string | null; preview: string } {
  const existed = fs.existsSync(filePath);
  const root = existed ? readJsonRecord(filePath) : {};
  const currentContainer = (root[containerKey] as Record<string, unknown> | undefined) ?? {};

  if (mode === "uninstall") {
    if (!existed || !("turnpack" in currentContainer)) {
      return { action: "unchanged", nextContent: null, preview: "No turnpack entry present." };
    }
    const nextContainer = { ...currentContainer };
    delete nextContainer.turnpack;
    const nextRoot = { ...root, [containerKey]: nextContainer };
    const nextContent = `${JSON.stringify(nextRoot, null, 2)}\n`;
    return {
      action: "remove",
      nextContent,
      preview: `- ${containerKey}.turnpack`,
    };
  }

  const nextContainer = { ...currentContainer, turnpack: entryBuilder() };
  const nextRoot = { ...root, [containerKey]: nextContainer };
  const nextContent = `${JSON.stringify(nextRoot, null, 2)}\n`;
  const prevContent = existed ? fs.readFileSync(filePath, "utf8") : "";
  if (prevContent === nextContent) {
    return { action: "unchanged", nextContent: null, preview: "Already configured." };
  }
  return {
    action: existed ? "update" : "create",
    nextContent,
    preview: `+ ${containerKey}.turnpack -> npx -y turnpack serve`,
  };
}

function stripTomlTurnpackSection(toml: string): string {
  const sectionPattern =
    /(?:^|\r?\n)# Added by turnpack\r?\n\[mcp_servers\.turnpack\][\s\S]*?(?=\r?\n\[|\s*$)|(?:^|\r?\n)\[mcp_servers\.turnpack\][\s\S]*?(?=\r?\n\[|\s*$)/g;
  const cleaned = toml.replace(sectionPattern, "").replace(/\n{3,}/g, "\n\n").trimEnd();
  return cleaned ? `${cleaned}\n` : "";
}

function upsertTomlMcp(
  filePath: string,
  mode: "init" | "uninstall",
): { action: PlannedFileChange["action"]; nextContent: string | null; preview: string } {
  const existed = fs.existsSync(filePath);
  const prev = existed ? fs.readFileSync(filePath, "utf8") : "";
  const hasSection = /\[mcp_servers\.turnpack\]/.test(prev);

  if (mode === "uninstall") {
    if (!existed || !hasSection) {
      return { action: "unchanged", nextContent: null, preview: "No [mcp_servers.turnpack] present." };
    }
    return {
      action: "remove",
      nextContent: stripTomlTurnpackSection(prev),
      preview: "- [mcp_servers.turnpack]",
    };
  }

  const block = [
    "# Added by turnpack",
    "[mcp_servers.turnpack]",
    'command = "npx"',
    'args = ["-y", "turnpack", "serve"]',
    "",
  ].join("\n");

  const base = stripTomlTurnpackSection(prev);
  const nextContent = base ? `${base.trimEnd()}\n\n${block}` : block;
  if (prev === nextContent) {
    return { action: "unchanged", nextContent: null, preview: "Already configured." };
  }
  return {
    action: existed ? "update" : "create",
    nextContent,
    preview: "+ [mcp_servers.turnpack] (npx -y turnpack serve)",
  };
}

function buildPlan(options: {
  homeDir: string;
  mode: "init" | "uninstall";
  includeExperimental: boolean;
  clientFilter?: string;
}): PlannedFileChange[] {
  const { homeDir, mode, includeExperimental, clientFilter } = options;
  const stdMcpEntry = (): Record<string, unknown> => ({
    command: "npx",
    args: ["-y", "turnpack", "serve"],
  });
  const openCodeEntry = (): Record<string, unknown> => ({
    type: "local",
    command: ["npx", "-y", "turnpack", "serve"],
  });

  const targets: Array<{
    key: string;
    client: string;
    tier: "tier1" | "experimental";
    detectDir: string;
    plan: () => Omit<PlannedFileChange, "client" | "tier">;
  }> = [
    {
      key: "claude",
      client: "Claude Code",
      tier: "tier1",
      detectDir: path.join(homeDir, ".claude"),
      plan: () => {
        const filePath = path.join(homeDir, ".claude.json");
        return { filePath, ...upsertJsonMcp(filePath, "mcpServers", stdMcpEntry, mode) };
      },
    },
    {
      key: "codex",
      client: "Codex CLI",
      tier: "tier1",
      detectDir: path.join(homeDir, ".codex"),
      plan: () => {
        const filePath = path.join(homeDir, ".codex", "config.toml");
        return { filePath, ...upsertTomlMcp(filePath, mode) };
      },
    },
    {
      key: "omp",
      client: "OMP (oh-my-pi) MCP",
      tier: "tier1",
      detectDir: path.join(homeDir, ".omp"),
      plan: () => {
        const filePath = path.join(homeDir, ".omp", "agent", "mcp.json");
        return { filePath, ...upsertJsonMcp(filePath, "mcpServers", stdMcpEntry, mode) };
      },
    },
    {
      key: "omp",
      client: "OMP Extension",
      tier: "tier1",
      detectDir: path.join(homeDir, ".omp"),
      plan: () => {
        const filePath = path.join(homeDir, ".omp", "agent", "extensions", "turnpack.ts");
        const existed = fs.existsSync(filePath);
        if (mode === "uninstall") {
          return existed
            ? { filePath, action: "remove", nextContent: null, preview: `- delete ${filePath}` }
            : { filePath, action: "unchanged", nextContent: null, preview: "Not installed." };
        }
        const source = getOmpExtensionSource();
        if (existed && fs.readFileSync(filePath, "utf8") === source) {
          return { filePath, action: "unchanged", nextContent: null, preview: "Already up to date." };
        }
        return {
          filePath,
          action: existed ? "update" : "create",
          nextContent: source,
          preview: `+ install cache-safe OMP plugin (${filePath})`,
        };
      },
    },
    {
      key: "cursor",
      client: "Cursor (experimental MCP)",
      tier: "experimental",
      detectDir: path.join(homeDir, ".cursor"),
      plan: () => {
        const filePath = path.join(homeDir, ".cursor", "mcp.json");
        return { filePath, ...upsertJsonMcp(filePath, "mcpServers", stdMcpEntry, mode) };
      },
    },
    {
      key: "gemini",
      client: "Gemini CLI (experimental MCP)",
      tier: "experimental",
      detectDir: path.join(homeDir, ".gemini"),
      plan: () => {
        const filePath = path.join(homeDir, ".gemini", "settings.json");
        return { filePath, ...upsertJsonMcp(filePath, "mcpServers", stdMcpEntry, mode) };
      },
    },
    {
      key: "opencode",
      client: "OpenCode (experimental MCP)",
      tier: "experimental",
      detectDir: path.join(homeDir, ".config", "opencode"),
      plan: () => {
        const filePath = path.join(homeDir, ".config", "opencode", "opencode.json");
        return { filePath, ...upsertJsonMcp(filePath, "mcp", openCodeEntry, mode) };
      },
    },
    {
      key: "grok",
      client: "Grok CLI (experimental MCP)",
      tier: "experimental",
      detectDir: path.join(homeDir, ".grok"),
      plan: () => {
        const filePath = path.join(homeDir, ".grok", "config.toml");
        return { filePath, ...upsertTomlMcp(filePath, mode) };
      },
    },
  ];

  const changes: PlannedFileChange[] = [];
  for (const target of targets) {
    if (target.tier === "experimental" && !includeExperimental && clientFilter !== target.key) {
      continue;
    }
    if (clientFilter && clientFilter !== "all" && target.key !== clientFilter) {
      continue;
    }

    const detected =
      Boolean(clientFilter && clientFilter !== "all") ||
      fs.existsSync(target.detectDir) ||
      (target.key === "claude" && fs.existsSync(path.join(homeDir, ".claude.json")));

    if (!detected && mode === "init") {
      continue;
    }

    const built = target.plan();
    changes.push({
      client: target.client,
      tier: target.tier,
      ...built,
    });
  }

  return changes;
}

async function promptConfirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return await new Promise((resolvePrompt) => {
    rl.question(question, (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      resolvePrompt(trimmed === "y" || trimmed === "yes");
    });
  });
}

export async function runInstaller(
  mode: "init" | "uninstall",
  argv: string[],
): Promise<InstallerResult> {
  let homeDir = os.homedir();
  let yes = false;
  let dryRun = false;
  let includeExperimental = false;
  let clientFilter: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--home" && next) {
      homeDir = path.resolve(next);
      i += 1;
    } else if (arg === "--client" && next) {
      clientFilter = next.toLowerCase();
      i += 1;
    } else if (arg === "--yes" || arg === "-y") {
      yes = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--experimental") {
      includeExperimental = true;
    }
  }

  const changes = buildPlan({ homeDir, mode, includeExperimental, clientFilter });
  const pending = changes.filter((c) => c.action !== "unchanged");

  process.stdout.write(`\nturnpack ${mode} (home: ${homeDir})\n`);
  process.stdout.write("─────────────────────────────────────────────────────────────────\n");
  if (changes.length === 0) {
    process.stdout.write(
      "  No supported client config folders detected.\n  Pass --client claude|codex|omp (or --experimental) to configure explicitly.\n\n",
    );
    return { applied: false, changes };
  }

  for (const ch of changes) {
    process.stdout.write(
      `  [${ch.action.toUpperCase().padEnd(9)}] ${ch.client} -> ${ch.filePath}\n    ${ch.preview}\n`,
    );
  }
  process.stdout.write("─────────────────────────────────────────────────────────────────\n");

  if (pending.length === 0) {
    process.stdout.write("  Everything is already clean and up to date.\n\n");
    return { applied: true, changes };
  }

  if (dryRun) {
    process.stdout.write("  Dry run complete. No files were modified.\n\n");
    return { applied: false, changes };
  }

  if (!yes) {
    if (!process.stdin.isTTY) {
      process.stdout.write("  Preview only in non-interactive mode. Re-run with --yes to apply.\n\n");
      return { applied: false, changes };
    }
    const ok = await promptConfirm(`Apply ${pending.length} change(s) with .turnpack.bak backups? [y/N] `);
    if (!ok) {
      process.stdout.write("  Cancelled.\n\n");
      return { applied: false, changes };
    }
  }

  for (const ch of pending) {
    if (ch.action === "remove" && ch.nextContent === null) {
      if (fs.existsSync(ch.filePath)) {
        fs.copyFileSync(ch.filePath, `${ch.filePath}.turnpack.bak`);
        fs.unlinkSync(ch.filePath);
      }
      continue;
    }
    if (ch.nextContent !== null) {
      fs.mkdirSync(path.dirname(ch.filePath), { recursive: true });
      if (fs.existsSync(ch.filePath)) {
        fs.copyFileSync(ch.filePath, `${ch.filePath}.turnpack.bak`);
      }
      fs.writeFileSync(ch.filePath, ch.nextContent, "utf8");
    }
  }

  process.stdout.write(`  Applied ${pending.length} change(s). Next: npx turnpack doctor\n\n`);
  return { applied: true, changes };
}
