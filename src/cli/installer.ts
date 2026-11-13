import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { VERSION } from "../version.js";
import { probeLaunch, type LaunchSpec } from "./probe.js";

export interface PlannedFileChange {
  client: string;
  tier: "tier1" | "experimental";
  filePath: string;
  action: "update" | "create" | "remove" | "unchanged" | "skipped";
  preview: string;
  nextContent: string | null;
  /** Set on the step that copies the server's own files: the directory to copy from. */
  copyFrom?: string;
  /** Set on a step that removes a directory rather than a file. */
  removeDir?: boolean;
}

export interface InstallerResult {
  applied: boolean;
  changes: PlannedFileChange[];
}

/** How an AI app is told to start the server. */
export interface Launch extends LaunchSpec {
  /** "local": a Node binary and a file on this machine. "npx": resolved from npm on every start. */
  via: "local" | "npx";
  /** When the server's files must first be copied somewhere that will still exist next week. */
  copyFrom?: string;
  copyTo?: string;
}

/**
 * The portable launch: `npx`, pinned to this exact version so a later release cannot change
 * what an app runs without anyone asking.
 *
 * On Windows `npx` is a batch file (`npx.cmd`), and many MCP clients start servers without a
 * shell, where a batch file is "program not found". Going through `cmd /c` works in all of
 * them, so that is what gets written there.
 */
export function serverCommand(platform: NodeJS.Platform = process.platform): {
  command: string;
  args: string[];
} {
  const npx = ["npx", "-y", `turnpack@${VERSION}`, "serve"];
  return platform === "win32"
    ? { command: "cmd", args: ["/c", ...npx] }
    : { command: "npx", args: npx.slice(1) };
}

function sameFile(a: string, b: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * The path to write for "this Node". `process.execPath` is right today but can be a path that
 * disappears: Homebrew installs each Node under a versioned Cellar directory and removes it on
 * upgrade, while `/opt/homebrew/bin/node` goes on pointing at the current one. So when a
 * directory on PATH holds a `node` that resolves to the running binary, that longer-lived name
 * is used. Per-shell and temporary directories are skipped: they do not outlive the terminal.
 */
export function stableNodePath(
  execPath: string = process.execPath,
  envPath: string = process.env.PATH ?? "",
  platform: NodeJS.Platform = process.platform,
): string {
  let realExec: string;
  try {
    realExec = fs.realpathSync(execPath);
  } catch {
    return execPath;
  }
  const name = platform === "win32" ? "node.exe" : "node";
  for (const dir of envPath.split(platform === "win32" ? ";" : ":").filter(Boolean)) {
    if (/fnm_multishells|[\\/]te?mp[\\/]/i.test(`${dir}${path.sep}`) || isUnderTemp(dir)) continue;
    const candidate = path.join(dir, name);
    try {
      if (sameFile(fs.realpathSync(candidate), realExec, platform)) return candidate;
    } catch {
      // Not in this directory.
    }
  }
  return execPath;
}

function getPackageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..");
}

/** True for a path inside the system's temporary directory, wherever the system keeps it. */
function isUnderTemp(target: string): boolean {
  const real = (candidate: string): string => {
    try {
      return fs.realpathSync(candidate);
    } catch {
      return path.resolve(candidate);
    }
  };
  const rel = path.relative(real(os.tmpdir()), real(target));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** True when this copy of Turnpack lives somewhere a package runner may delete it. */
export function isTransientInstall(packageRoot: string): boolean {
  if (/[\\/](_npx|dlx|bunx-[^\\/]+)[\\/]/.test(packageRoot)) return true;
  if (/[\\/]\.bun[\\/]install[\\/]cache[\\/]/.test(packageRoot)) return true;
  return isUnderTemp(packageRoot);
}

/**
 * Decides how apps will start the server.
 *
 * The default is a file on this machine started by an absolute Node path: it starts in tens of
 * milliseconds, works offline, cannot change version behind your back, and does not depend on
 * the PATH a desktop app happens to be given. If this copy came from `npx` (a cache that gets
 * cleaned), the files are first copied to `~/.turnpack/versions/<version>`; a global install or
 * a checkout is used where it is.
 */
export function planLaunch(options: { homeDir: string; npx?: boolean; copy?: boolean }): Launch {
  if (options.npx) return { ...serverCommand(), via: "npx" };
  const packageRoot = getPackageRoot();
  const node = stableNodePath();
  if (!options.copy && !isTransientInstall(packageRoot)) {
    return { command: node, args: [path.join(packageRoot, "dist", "cli.js"), "serve"], via: "local" };
  }
  const copyTo = path.join(options.homeDir, ".turnpack", "versions", VERSION);
  return {
    command: node,
    args: [path.join(copyTo, "dist", "cli.js"), "serve"],
    via: "local",
    copyFrom: packageRoot,
    copyTo,
  };
}

const COPIED_ENTRIES = ["dist", "extensions", "package.json", "LICENSE", "NOTICE"];

function sameInstalledCopy(from: string, to: string): boolean {
  try {
    for (const rel of ["package.json", path.join("dist", "cli.js"), path.join("dist", "mcp-server.js")]) {
      if (!fs.readFileSync(path.join(from, rel)).equals(fs.readFileSync(path.join(to, rel)))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Copies the server's files beside the final location and swaps them in, so a half copy is never used. */
function installCopy(from: string, to: string): void {
  const staging = `${to}.tmp-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  for (const entry of COPIED_ENTRIES) {
    const source = path.join(from, entry);
    if (fs.existsSync(source)) fs.cpSync(source, path.join(staging, entry), { recursive: true });
  }
  fs.rmSync(to, { recursive: true, force: true });
  fs.renameSync(staging, to);
}

function describeLaunch(launch: LaunchSpec): string {
  return [launch.command, ...launch.args].map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(" ");
}

function getOmpExtensionSource(): string {
  const extPath = path.join(getPackageRoot(), "extensions", "omp-turnpack.ts");
  if (fs.existsSync(extPath)) {
    return fs.readFileSync(extPath, "utf8");
  }
  return `export default function turnpackExtension(pi) { pi.on("session_start", (_e, c) => c.ui?.setStatus?.("turnpack", "turnpack ready")); }\n`;
}

// ---------------------------------------------------------------------------------------------
// JSON configs
// ---------------------------------------------------------------------------------------------

interface JsonShape {
  indent: string | number;
  eol: string;
  finalNewline: boolean;
}

/** How the file is laid out, so rewriting it changes the one entry and nothing else. */
function jsonShapeOf(text: string): JsonShape {
  const indentMatch = /\n([ \t]+)"/.exec(text);
  return {
    indent: indentMatch?.[1]?.includes("\t") ? "\t" : (indentMatch?.[1]?.length ?? 2),
    eol: text.includes("\r\n") ? "\r\n" : "\n",
    finalNewline: text.length === 0 || /\n$/.test(text),
  };
}

function writeJsonLike(root: Record<string, unknown>, shape: JsonShape): string {
  const body = JSON.stringify(root, null, shape.indent);
  const text = shape.finalNewline ? `${body}\n` : body;
  return shape.eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

function readJsonRecord(filePath: string): { root: Record<string, unknown>; text: string } {
  if (!fs.existsSync(filePath)) return { root: {}, text: "" };
  const text = fs.readFileSync(filePath, "utf8");
  if (!text.trim()) return { root: {}, text };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (err) {
    throw new Error(`not plain JSON (${err instanceof Error ? err.message : String(err)}); add the entry by hand`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("expected a JSON object at the top level; add the entry by hand");
  }
  return { root: parsed as Record<string, unknown>, text };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type JsonStyle = "standard" | "typed" | "opencode";

/**
 * The entry for one app. Anything the user added to an existing entry (an `env`, a timeout, an
 * approval setting) is kept; only the keys that say how to start the server are replaced.
 */
function buildJsonEntry(
  style: JsonStyle,
  launch: LaunchSpec,
  existing: unknown,
  extras: Record<string, unknown>,
  root: string | undefined,
): Record<string, unknown> {
  const kept = isObject(existing) ? { ...existing } : {};
  let entry: Record<string, unknown>;
  if (style === "opencode") {
    delete kept.command;
    entry = { ...kept, type: "local", command: [launch.command, ...launch.args] };
  } else {
    delete kept.command;
    delete kept.args;
    // Defaults first, then whatever the user set themselves, so their value wins.
    entry = { ...(style === "typed" ? { type: "stdio" } : {}), command: launch.command, args: launch.args, ...extras, ...kept };
    if (style === "typed") entry.type = "stdio";
  }
  if (root) {
    const envKey = style === "opencode" ? "environment" : "env";
    entry[envKey] = { ...(isObject(entry[envKey]) ? (entry[envKey] as Record<string, unknown>) : {}), TURNPACK_ROOT: root };
  }
  return entry;
}

function upsertJsonMcp(
  filePath: string,
  containerKey: "mcpServers" | "mcp",
  build: (existing: unknown) => Record<string, unknown>,
  mode: "init" | "uninstall",
  launchText: string,
): { action: PlannedFileChange["action"]; nextContent: string | null; preview: string } {
  const existed = fs.existsSync(filePath);
  const { root, text } = readJsonRecord(filePath);
  const shape = jsonShapeOf(text);
  const currentContainer = isObject(root[containerKey]) ? (root[containerKey] as Record<string, unknown>) : {};

  if (mode === "uninstall") {
    if (!existed || !("turnpack" in currentContainer)) {
      return { action: "unchanged", nextContent: null, preview: "No turnpack entry present." };
    }
    const nextContainer = { ...currentContainer };
    delete nextContainer.turnpack;
    return {
      action: "remove",
      nextContent: writeJsonLike({ ...root, [containerKey]: nextContainer }, shape),
      preview: `- ${containerKey}.turnpack`,
    };
  }

  const nextContainer = { ...currentContainer, turnpack: build(currentContainer.turnpack) };
  const nextContent = writeJsonLike({ ...root, [containerKey]: nextContainer }, shape);
  if (existed && JSON.stringify(currentContainer.turnpack) === JSON.stringify(nextContainer.turnpack)) {
    return { action: "unchanged", nextContent: null, preview: "Already configured." };
  }
  return {
    action: existed ? "update" : "create",
    nextContent,
    preview: `+ ${containerKey}.turnpack -> ${launchText}`,
  };
}

// ---------------------------------------------------------------------------------------------
// TOML configs (Codex, Grok)
// ---------------------------------------------------------------------------------------------

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

const TOML_HEADER = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/;
const TURNPACK_TABLE = /^mcp_servers\.(?:turnpack|"turnpack"|'turnpack')(?:\.(.+))?$/;

interface TomlSplit {
  /** The file without any `[mcp_servers.turnpack…]` table. */
  rest: string;
  /** Body lines of the main table, or null when there is none. */
  main: string[] | null;
  /** Sub-tables such as `env` or `tools.ship`, by the part of the name after `turnpack.`. */
  subs: Map<string, string[]>;
  eol: string;
}

/** Takes the Turnpack tables out of a TOML file, line by line, leaving every other byte alone. */
function splitTurnpackToml(toml: string): TomlSplit {
  const eol = toml.includes("\r\n") ? "\r\n" : "\n";
  const kept: string[] = [];
  const subs = new Map<string, string[]>();
  let main: string[] | null = null;
  let current: string[] | null = null;

  for (const line of toml.split(/\r?\n/)) {
    const header = TOML_HEADER.exec(line);
    if (header) {
      const ours = TURNPACK_TABLE.exec(header[1] ?? "");
      if (ours) {
        if (kept[kept.length - 1]?.trim() === "# Added by turnpack") kept.pop();
        current = [];
        if (ours[1]) subs.set(ours[1], current);
        else main = current;
        continue;
      }
      current = null;
    }
    if (current) current.push(line);
    else kept.push(line);
  }
  const rest = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { rest: rest ? `${rest}\n` : "", main, subs, eol };
}

// Replaced on every init. The timeouts are not here: init supplies a default for them, and a
// value you set yourself stays.
const MANAGED_TOML_KEYS = /^\s*(command|args|enabled)\s*=/;

/** Lines of a table body a user added themselves: anything that is not one of the keys init writes. */
function unmanagedLines(body: string[] | null): string[] {
  if (!body) return [];
  const out: string[] = [];
  let skippingArray = false;
  for (const line of body) {
    if (skippingArray) {
      if (line.includes("]")) skippingArray = false;
      continue;
    }
    if (MANAGED_TOML_KEYS.test(line)) {
      // A managed `args = [` may run over several lines.
      if (/=\s*\[/.test(line) && !line.includes("]")) skippingArray = true;
      continue;
    }
    if (line.trim()) out.push(line);
  }
  return out;
}

function upsertTomlMcp(
  filePath: string,
  mode: "init" | "uninstall",
  launch: LaunchSpec,
  options: { enabledKey: boolean; root?: string },
): { action: PlannedFileChange["action"]; nextContent: string | null; preview: string } {
  const existed = fs.existsSync(filePath);
  const prev = existed ? fs.readFileSync(filePath, "utf8") : "";
  const split = splitTurnpackToml(prev);
  const withEol = (text: string): string => (split.eol === "\r\n" ? text.replace(/\r?\n/g, "\r\n") : text);

  if (mode === "uninstall") {
    if (!existed || (split.main === null && split.subs.size === 0)) {
      return { action: "unchanged", nextContent: null, preview: "No [mcp_servers.turnpack] present." };
    }
    return { action: "remove", nextContent: withEol(split.rest), preview: "- [mcp_servers.turnpack]" };
  }

  // The default tool timeout in these apps is 60 seconds, which is also ship's default verify
  // timeout: without more room the app gives up at the moment ship is about to report. Ten
  // minutes covers ship's longest verify (five minutes a command) with room for a second one.
  const yours = unmanagedLines(split.main);
  const has = (key: RegExp): boolean => yours.some((line) => key.test(line));
  const block = [
    "# Added by turnpack",
    "[mcp_servers.turnpack]",
    `command = ${tomlString(launch.command)}`,
    `args = [${launch.args.map(tomlString).join(", ")}]`,
    ...(options.enabledKey ? ["enabled = true"] : []),
    ...(has(/^\s*startup_timeout_(sec|ms)\s*=/) ? [] : ["startup_timeout_sec = 20"]),
    ...(has(/^\s*tool_timeout_sec\s*=/) ? [] : ["tool_timeout_sec = 600"]),
    ...yours,
  ];
  const envLines = (split.subs.get("env") ?? []).filter(
    (line) => line.trim() && !(options.root && /^\s*TURNPACK_ROOT\s*=/.test(line)),
  );
  if (options.root) envLines.push(`TURNPACK_ROOT = ${tomlString(options.root)}`);
  if (envLines.length > 0) block.push("", "[mcp_servers.turnpack.env]", ...envLines);
  for (const [name, body] of split.subs) {
    if (name === "env") continue;
    block.push("", `[mcp_servers.turnpack.${name}]`, ...body.filter((line) => line.trim()));
  }

  const nextContent = withEol(`${split.rest ? `${split.rest}\n` : ""}${block.join("\n")}\n`);
  if (prev === nextContent) {
    return { action: "unchanged", nextContent: null, preview: "Already configured." };
  }
  return {
    action: existed ? "update" : "create",
    nextContent,
    preview: `+ [mcp_servers.turnpack] -> ${describeLaunch(launch)}`,
  };
}

function tomlStrings(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)) {
    out.push(match[1] !== undefined ? match[1].replace(/\\(["\\])/g, "$1") : (match[2] ?? ""));
  }
  return out;
}

/** The launch a TOML config holds for Turnpack, or null. Good enough to run it, not a TOML parser. */
function readTomlLaunch(toml: string): LaunchSpec | null {
  const split = splitTurnpackToml(toml);
  if (!split.main) return null;
  const body = split.main.join("\n");
  const command = tomlStrings(/^\s*command\s*=\s*(.+)$/m.exec(body)?.[1] ?? "")[0];
  if (!command) return null;
  const args = tomlStrings(/^\s*args\s*=\s*\[([\s\S]*?)\]/m.exec(body)?.[1] ?? "");
  const env: Record<string, string> = {};
  for (const line of split.subs.get("env") ?? []) {
    const pair = /^\s*([A-Za-z_][\w]*)\s*=\s*(.+)$/.exec(line);
    const value = pair ? tomlStrings(pair[2] ?? "")[0] : undefined;
    if (pair?.[1] && value !== undefined) env[pair[1]] = value;
  }
  return { command, args, ...(Object.keys(env).length > 0 ? { env } : {}) };
}

// ---------------------------------------------------------------------------------------------
// The apps
// ---------------------------------------------------------------------------------------------

export interface AppTarget {
  key: string;
  client: string;
  tier: "tier1" | "experimental";
  detectDir: string;
  configPath: string;
  format: "json" | "toml";
  containerKey: "mcpServers" | "mcp";
  jsonStyle: JsonStyle;
  /** Keys added to a JSON entry beyond the launch itself. */
  extras: Record<string, unknown>;
  tomlEnabledKey: boolean;
}

function claudeDesktopDir(homeDir: string, platform: NodeJS.Platform): string {
  if (platform === "win32") return path.join(homeDir, "AppData", "Roaming", "Claude");
  if (platform === "darwin") return path.join(homeDir, "Library", "Application Support", "Claude");
  return path.join(homeDir, ".config", "Claude");
}

/** Every app `init` knows how to configure, and where each keeps its MCP servers. */
export function appTargets(homeDir: string, platform: NodeJS.Platform = process.platform): AppTarget[] {
  const json = (
    key: string,
    client: string,
    tier: AppTarget["tier"],
    detectDir: string,
    configPath: string,
    jsonStyle: JsonStyle = "standard",
    extras: Record<string, unknown> = {},
    containerKey: AppTarget["containerKey"] = "mcpServers",
  ): AppTarget => ({ key, client, tier, detectDir, configPath, format: "json", containerKey, jsonStyle, extras, tomlEnabledKey: false });
  const toml = (key: string, client: string, detectDir: string, enabledKey: boolean): AppTarget => ({
    key,
    client,
    tier: "tier1",
    detectDir,
    configPath: path.join(detectDir, "config.toml"),
    format: "toml",
    containerKey: "mcpServers",
    jsonStyle: "standard",
    extras: {},
    tomlEnabledKey: enabledKey,
  });
  const desktop = claudeDesktopDir(homeDir, platform);
  return [
    json("claude", "Claude Code", "tier1", path.join(homeDir, ".claude"), path.join(homeDir, ".claude.json"), "typed"),
    json("claude-desktop", "Claude Desktop", "tier1", desktop, path.join(desktop, "claude_desktop_config.json")),
    // One file serves both: the ChatGPT desktop app runs Codex and reads the same config.
    toml("codex", "Codex CLI and ChatGPT desktop app", path.join(homeDir, ".codex"), false),
    // OMP's request timeout is per server and in milliseconds; see the note on TOML timeouts.
    json("omp", "OMP (oh-my-pi) MCP", "tier1", path.join(homeDir, ".omp"), path.join(homeDir, ".omp", "agent", "mcp.json"), "typed", { timeout: 600000 }),
    toml("grok", "Grok Build (grok CLI)", path.join(homeDir, ".grok"), true),
    json("cursor", "Cursor (experimental MCP)", "experimental", path.join(homeDir, ".cursor"), path.join(homeDir, ".cursor", "mcp.json")),
    json("gemini", "Gemini CLI (experimental MCP)", "experimental", path.join(homeDir, ".gemini"), path.join(homeDir, ".gemini", "settings.json")),
    json(
      "opencode",
      "OpenCode (experimental MCP)",
      "experimental",
      path.join(homeDir, ".config", "opencode"),
      path.join(homeDir, ".config", "opencode", "opencode.json"),
      "opencode",
      {},
      "mcp",
    ),
  ];
}

/** The launch an app's config currently holds for Turnpack, or null when it has none. */
export function readConfiguredLaunch(target: AppTarget): LaunchSpec | null {
  if (!fs.existsSync(target.configPath)) return null;
  if (target.format === "toml") return readTomlLaunch(fs.readFileSync(target.configPath, "utf8"));
  const { root } = readJsonRecord(target.configPath);
  const container = root[target.containerKey];
  const entry = isObject(container) ? container.turnpack : undefined;
  if (!isObject(entry)) return null;
  const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
  const envSource = isObject(entry.env) ? entry.env : isObject(entry.environment) ? entry.environment : {};
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envSource)) if (typeof value === "string") env[key] = value;
  const withEnv = Object.keys(env).length > 0 ? { env } : {};
  if (Array.isArray(entry.command)) {
    const [command, ...args] = strings(entry.command);
    return command ? { command, args, ...withEnv } : null;
  }
  return typeof entry.command === "string" ? { command: entry.command, args: strings(entry.args), ...withEnv } : null;
}

const OMP_EXTENSION = (homeDir: string): string => path.join(homeDir, ".omp", "agent", "extensions", "turnpack.ts");

function planOmpExtension(homeDir: string, mode: "init" | "uninstall"): Omit<PlannedFileChange, "client" | "tier"> {
  const filePath = OMP_EXTENSION(homeDir);
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
}

function buildPlan(options: {
  homeDir: string;
  mode: "init" | "uninstall";
  includeExperimental: boolean;
  clientFilter?: string;
  launch: Launch;
  root?: string;
}): PlannedFileChange[] {
  const { homeDir, mode, includeExperimental, clientFilter, launch, root } = options;
  const launchText = describeLaunch(launch);
  const changes: PlannedFileChange[] = [];

  for (const target of appTargets(homeDir)) {
    if (target.tier === "experimental" && !includeExperimental && clientFilter !== target.key) continue;
    if (clientFilter && clientFilter !== "all" && target.key !== clientFilter) continue;

    const detected =
      Boolean(clientFilter && clientFilter !== "all") ||
      fs.existsSync(target.detectDir) ||
      (target.key === "claude" && fs.existsSync(target.configPath));
    if (!detected && mode === "init") continue;

    try {
      const planned =
        target.format === "toml"
          ? upsertTomlMcp(target.configPath, mode, launch, { enabledKey: target.tomlEnabledKey, root })
          : upsertJsonMcp(
              target.configPath,
              target.containerKey,
              (existing) => buildJsonEntry(target.jsonStyle, launch, existing, target.extras, root),
              mode,
              launchText,
            );
      changes.push({ client: target.client, tier: target.tier, filePath: target.configPath, ...planned });
      if (target.key === "omp") {
        changes.push({ client: "OMP Extension", tier: "tier1", ...planOmpExtension(homeDir, mode) });
      }
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

  // The server's own files, when they have to be copied somewhere durable first.
  const versionsDir = path.join(homeDir, ".turnpack", "versions");
  if (mode === "init" && launch.copyFrom && launch.copyTo && changes.some((c) => c.action !== "skipped")) {
    const current = sameInstalledCopy(launch.copyFrom, launch.copyTo);
    changes.unshift({
      client: "Turnpack server files",
      tier: "tier1",
      filePath: launch.copyTo,
      action: current ? "unchanged" : fs.existsSync(launch.copyTo) ? "update" : "create",
      preview: current ? `Version ${VERSION} already in place.` : `+ copy version ${VERSION} here, so apps do not depend on a package cache`,
      nextContent: null,
      copyFrom: launch.copyFrom,
    });
  }
  if (mode === "uninstall" && (!clientFilter || clientFilter === "all") && fs.existsSync(versionsDir)) {
    changes.push({
      client: "Turnpack server files",
      tier: "tier1",
      filePath: versionsDir,
      action: "remove",
      preview: `- delete ${versionsDir}`,
      nextContent: null,
      removeDir: true,
    });
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

const CLIENT_KEYS = "claude | claude-desktop | codex | omp | grok | cursor | gemini | opencode";

export async function runInstaller(
  mode: "init" | "uninstall",
  argv: string[],
): Promise<InstallerResult> {
  let homeDir = os.homedir();
  let yes = false;
  let dryRun = false;
  let includeExperimental = false;
  let clientFilter: string | undefined;
  let npx = false;
  let copy = false;
  let rootArg: string | undefined;
  let check = true;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--home" && next) {
      homeDir = path.resolve(next);
      i += 1;
    } else if (arg === "--client" && next) {
      clientFilter = next.toLowerCase();
      i += 1;
    } else if (arg === "--root" && next) {
      rootArg = next;
      i += 1;
    } else if (arg === "--yes" || arg === "-y") {
      yes = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--experimental") {
      includeExperimental = true;
    } else if (arg === "--npx") {
      npx = true;
    } else if (arg === "--copy") {
      copy = true;
    } else if (arg === "--no-check") {
      check = false;
    }
  }

  const out = (text: string): void => {
    process.stdout.write(text);
  };

  let root: string | undefined;
  if (rootArg !== undefined && mode === "init") {
    // A pinned folder applies to every session of the app it is written for. That is what a
    // chat app with no project needs and what a coding CLI must never get by accident.
    if (!clientFilter || clientFilter === "all") {
      process.stderr.write(
        "turnpack: --root pins one folder for every session of an app, so name the app too:\n  turnpack init --client claude-desktop --root <folder>\n",
      );
      process.exitCode = 1;
      return { applied: false, changes: [] };
    }
    try {
      root = fs.realpathSync(path.resolve(rootArg));
      if (!fs.statSync(root).isDirectory()) throw new Error("not a directory");
    } catch {
      process.stderr.write(`turnpack: --root "${rootArg}" is not an existing folder.\n`);
      process.exitCode = 1;
      return { applied: false, changes: [] };
    }
  }

  const launch = planLaunch({ homeDir, npx, copy });
  const changes = buildPlan({ homeDir, mode, includeExperimental, clientFilter, launch, root });
  const pending = changes.filter((c) => c.action !== "unchanged" && c.action !== "skipped");

  out(`\nturnpack ${mode} (home: ${homeDir})\n`);
  out("─────────────────────────────────────────────────────────────────\n");
  if (changes.length === 0) {
    out(
      "  No supported AI app config found in this home directory.\n" +
        `  Name one explicitly: --client ${CLIENT_KEYS}\n` +
        "  or copy a snippet from https://github.com/OnlyTerp/turnpack#set-it-up\n\n",
    );
    return { applied: false, changes };
  }

  for (const ch of changes) {
    out(`  [${ch.action.toUpperCase().padEnd(9)}] ${ch.client} -> ${ch.filePath}\n    ${ch.preview}\n`);
  }
  out("─────────────────────────────────────────────────────────────────\n");

  if (pending.length === 0) {
    const skipped = changes.some((c) => c.action === "skipped");
    out(
      skipped
        ? "  Nothing to apply. The file(s) marked SKIPPED above were left untouched.\n\n"
        : "  Everything is already clean and up to date.\n\n",
    );
    return { applied: !skipped, changes };
  }

  if (dryRun) {
    out("  Dry run complete. No files were modified.\n\n");
    return { applied: false, changes };
  }

  if (!yes) {
    if (!process.stdin.isTTY) {
      out("  Preview only in non-interactive mode. Re-run with --yes to apply.\n\n");
      return { applied: false, changes };
    }
    const ok = await promptConfirm(`Apply ${pending.length} change(s) with .turnpack.bak backups? [y/N] `);
    if (!ok) {
      out("  Cancelled.\n\n");
      return { applied: false, changes };
    }
  }

  for (const ch of pending) {
    if (ch.copyFrom) {
      fs.mkdirSync(path.dirname(ch.filePath), { recursive: true });
      installCopy(ch.copyFrom, ch.filePath);
      continue;
    }
    if (ch.removeDir) {
      fs.rmSync(ch.filePath, { recursive: true, force: true });
      try {
        fs.rmdirSync(path.dirname(ch.filePath));
      } catch {
        // Something else lives in ~/.turnpack: leave it.
      }
      continue;
    }
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

  if (mode === "uninstall") {
    out(`  Removed ${pending.length} Turnpack entr${pending.length === 1 ? "y" : "ies"}. Backups are next to each file as *.turnpack.bak\n\n`);
    return { applied: true, changes };
  }

  out(`  Applied ${pending.length} change(s).\n`);
  if (check) {
    // The entry exists; now prove it works, by starting the server the way the apps will.
    const probe = await probeLaunch(launch, os.tmpdir(), launch.via === "npx" ? 60000 : 15000);
    out(
      probe.ok
        ? `  Checked: the server starts with that command (${probe.ms} ms, version ${probe.version ?? "?"}, tools: ${probe.tools.join(", ")}).\n`
        : `  WARNING: the server did not start with that command: ${probe.error}.\n` +
            (launch.via === "npx"
              ? "    npx could not fetch the package. Run init without --npx to use the copy on this machine.\n"
              : "    Run: npx turnpack doctor\n"),
    );
    if (!probe.ok) process.exitCode = 1;
  }
  const configuredDesktop = changes.some((c) => c.client === "Claude Desktop" && c.action !== "skipped");
  if (configuredDesktop && !root) {
    out(
      "  Claude Desktop chats have no project folder. Tell Claude which folder to work in, or pin one:\n" +
        "    turnpack init --client claude-desktop --root <folder>\n",
    );
  }
  out("  Restart your AI apps so they load Turnpack. To check every app at any time: npx turnpack doctor\n\n");
  return { applied: true, changes };
}
