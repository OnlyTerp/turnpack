import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

export interface PlannedFileChange {
  client: string;
  tier: "tier1" | "experimental";
  filePath: string;
  action: "update" | "create" | "remove" | "unchanged" | "skipped";
  preview: string;
  nextContent: string | null;
}

export interface InstallerResult {
  applied: boolean;
  changes: PlannedFileChange[];
}

/**
 * The command an AI app should run to start the server.
 *
 * On Windows `npx` is a batch file (`npx.cmd`), and many MCP clients start servers without a
 * shell, where a batch file is "program not found". Going through `cmd /c` works in all of
 * them, so that is what gets written there.
 */
export function serverCommand(platform: NodeJS.Platform = process.platform): {
  command: string;
  args: string[];
} {
  const npx = ["npx", "-y", "turnpack", "serve"];
  return platform === "win32"
    ? { command: "cmd", args: ["/c", ...npx] }
    : { command: "npx", args: npx.slice(1) };
}

function describeLaunch(): string {
  const launch = serverCommand();
  return [launch.command, ...launch.args].join(" ");
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (err) {
    throw new Error(`not plain JSON (${err instanceof Error ? err.message : String(err)}); add the entry by hand`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("expected a JSON object at the top level; add the entry by hand");
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
    preview: `+ ${containerKey}.turnpack -> ${describeLaunch()}`,
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

  const launch = serverCommand();
  const block = [
    "# Added by turnpack",
    "[mcp_servers.turnpack]",
    `command = ${tomlString(launch.command)}`,
    `args = [${launch.args.map(tomlString).join(", ")}]`,
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
    preview: `+ [mcp_servers.turnpack] -> ${describeLaunch()}`,
  };
}

function buildPlan(options: {
  homeDir: string;
  mode: "init" | "uninstall";
  includeExperimental: boolean;
  clientFilter?: string;
}): PlannedFileChange[] {
  const { homeDir, mode, includeExperimental, clientFilter } = options;
  const launch = serverCommand();
  const stdMcpEntry = (): Record<string, unknown> => ({
    command: launch.command,
    args: launch.args,
  });
  const openCodeEntry = (): Record<string, unknown> => ({
    type: "local",
    command: [launch.command, ...launch.args],
  });

  const targets: Array<{
    key: string;
    client: string;
    tier: "tier1" | "experimental";
    detectDir: string;
    configPath: string;
    plan: () => Omit<PlannedFileChange, "client" | "tier">;
  }> = [
    {
      key: "claude",
      client: "Claude Code",
      tier: "tier1",
      detectDir: path.join(homeDir, ".claude"),
      configPath: path.join(homeDir, ".claude.json"),
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
      configPath: path.join(homeDir, ".codex", "config.toml"),
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
      configPath: path.join(homeDir, ".omp", "agent", "mcp.json"),
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
      configPath: path.join(homeDir, ".omp", "agent", "extensions", "turnpack.ts"),
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
      configPath: path.join(homeDir, ".cursor", "mcp.json"),
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
      configPath: path.join(homeDir, ".gemini", "settings.json"),
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
      configPath: path.join(homeDir, ".config", "opencode", "opencode.json"),
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
      configPath: path.join(homeDir, ".grok", "config.toml"),
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

    try {
      changes.push({ client: target.client, tier: target.tier, ...target.plan() });
    } catch (err) {
      // A config we cannot parse (comments, a syntax slip) is left exactly as it is. Rewriting
      // it from a failed parse is how installers eat people's settings.
      changes.push({
        client: target.client,
        tier: target.tier,
        filePath: target.configPath,
        action: "skipped",
        preview: `Left untouched: ${err instanceof Error ? err.message : String(err)}`,
        nextContent: null,
      });
    }
  }

  return changes;
}

/**
 * Replaces a config file in one step: the new content is written beside it and renamed over
 * it, so an interruption leaves either the old file or the new one, never half of each.
 */
function writeFileAtomic(filePath: string, content: string): void {
  const tmpPath = `${filePath}.turnpack.tmp`;
  let mode: number | undefined;
  try {
    mode = fs.statSync(filePath).mode & 0o7777;
  } catch {
    mode = undefined;
  }
  fs.writeFileSync(tmpPath, content, mode === undefined ? { encoding: "utf8" } : { encoding: "utf8", mode });
  try {
    fs.renameSync(tmpPath, filePath);
  } catch {
    // Windows refuses to rename over a file another program holds open. The backup already
    // exists at this point, so a plain overwrite is the safe fallback.
    fs.rmSync(tmpPath, { force: true });
    fs.writeFileSync(filePath, content, "utf8");
  }
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
  const pending = changes.filter((c) => c.action !== "unchanged" && c.action !== "skipped");

  process.stdout.write(`\nturnpack ${mode} (home: ${homeDir})\n`);
  process.stdout.write("─────────────────────────────────────────────────────────────────\n");
  if (changes.length === 0) {
    process.stdout.write(
      "  No supported AI app config found in this home directory.\n" +
        "  Name one explicitly: --client claude | codex | omp | cursor | gemini | opencode | grok\n" +
        "  or copy a snippet from https://github.com/OnlyTerp/turnpack#set-it-up\n\n",
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
    const skipped = changes.some((c) => c.action === "skipped");
    process.stdout.write(
      skipped
        ? "  Nothing to apply. The file(s) marked SKIPPED above were left untouched.\n\n"
        : "  Everything is already clean and up to date.\n\n",
    );
    return { applied: !skipped, changes };
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
      writeFileAtomic(ch.filePath, ch.nextContent);
    }
  }

  process.stdout.write(
    mode === "init"
      ? `  Applied ${pending.length} change(s). Restart your AI app so it loads Turnpack, then check with: npx turnpack doctor\n\n`
      : `  Removed ${pending.length} Turnpack entr${pending.length === 1 ? "y" : "ies"}. Backups are next to each file as *.turnpack.bak\n\n`,
  );
  return { applied: true, changes };
}
