import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runBatchDetailed, type BatchIsolation } from "../tools/batch.js";
import { VERSION } from "../version.js";
import { appTargets, readConfiguredLaunch } from "./installer.js";
import { probeLaunch, type ProbeResult } from "./probe.js";
import { bold, dim, green, red, rule, yellow } from "./style.js";
import { removeTempDir } from "./tempdir.js";

const execFileAsync = promisify(execFile);

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** A passing check that is still worth the reader's attention. */
  warn?: boolean;
}

/** What doctor found for one AI app on this machine. */
export interface AppCheck {
  client: string;
  configPath: string;
  /**
   * - "ready": the app's config starts a working server.
   * - "failed": it has an entry, and the entry does not start.
   * - "not-configured": the app is installed and has no Turnpack entry.
   * - "unreadable": its config could not be parsed.
   */
  state: "ready" | "failed" | "not-configured" | "unreadable";
  detail: string;
  /** A passing entry that is still worth changing. */
  warn?: boolean;
}

export interface DoctorReport {
  ok: boolean;
  nodeVersion: string;
  ripgrepVersion: string | null;
  schemaBytes: number;
  estimatedSchemaTokens: number;
  handshakeMs: number;
  batchIsolation: BatchIsolation | null;
  checks: DoctorCheck[];
  apps: AppCheck[];
}

/**
 * Looks at each AI app installed here and, where it has a Turnpack entry, starts the server
 * with that exact command. A config entry that points at a Node that was since upgraded away,
 * or at a package cache that was since cleaned, looks fine in the file and fails in the app.
 */
export async function checkApps(homeDir: string): Promise<AppCheck[]> {
  const results: AppCheck[] = [];
  const probes = new Map<string, Promise<ProbeResult>>();
  for (const target of appTargets(homeDir)) {
    if (!fs.existsSync(target.detectDir) && !fs.existsSync(target.configPath)) continue;
    const base = { client: target.client, configPath: target.configPath };
    let launch: ReturnType<typeof readConfiguredLaunch>;
    try {
      launch = readConfiguredLaunch(target);
    } catch (err) {
      results.push({ ...base, state: "unreadable", detail: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (!launch) {
      results.push({ ...base, state: "not-configured", detail: "no Turnpack entry (npx turnpack init adds one)" });
      continue;
    }
    const viaNpx = [launch.command, ...launch.args].some((part) => /^npx(\.cmd)?$/i.test(path.basename(part)));
    const key = JSON.stringify(launch);
    const probe =
      probes.get(key) ?? probeLaunch(launch, os.tmpdir(), viaNpx ? 60000 : 15000);
    probes.set(key, probe);
    const result = await probe;
    if (!result.ok) {
      results.push({ ...base, state: "failed", detail: `does not start: ${result.error} (npx turnpack init rewrites the entry)` });
      continue;
    }
    const notes: string[] = [];
    if (result.version && result.version !== VERSION) notes.push(`runs ${result.version}, this is ${VERSION}: run init to update`);
    if (viaNpx && !launch.args.some((arg) => /^turnpack@\d/.test(arg))) notes.push("unpinned npx: run init to pin it");
    results.push({
      ...base,
      state: "ready",
      warn: notes.length > 0,
      detail: `starts in ${result.ms} ms${notes.length ? `; ${notes.join("; ")}` : ""}`,
    });
  }
  return results;
}

function getCliEntryPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "cli.js");
}

interface LoopbackResult {
  responses: Map<number, Record<string, unknown>>;
  handshakeMs: number;
}

/** Starts the real server over stdio in `workspace`, sends `requests`, and collects the replies. */
function mcpLoopback(workspace: string, requests: Array<Record<string, unknown>>): Promise<LoopbackResult> {
  const wantedIds = requests.map((r) => r.id).filter((id): id is number => typeof id === "number");
  const t0 = performance.now();

  return new Promise((resolveProbe, rejectProbe) => {
    // Run the probe against the sandbox no matter where doctor itself was started from.
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.TURNPACK_ROOT;
    delete env.CLAUDE_PROJECT_DIR;
    delete env.TURNPACK_ALLOW_EXEC;
    const child = spawn(process.execPath, [getCliEntryPath(), "serve"], {
      cwd: workspace,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let handshakeMs = 0;
    let finished = false;
    const responses = new Map<number, Record<string, unknown>>();
    const timer = setTimeout(() => {
      finished = true;
      child.kill();
      rejectProbe(new Error("MCP loopback timed out after 10000ms"));
    }, 10000);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      let idx: number;
      while ((idx = stdout.indexOf("\n")) !== -1) {
        const line = stdout.slice(0, idx).trim();
        stdout = stdout.slice(idx + 1);
        if (!line) continue;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (typeof parsed.id !== "number") continue;
        responses.set(parsed.id, parsed);
        if (handshakeMs === 0 && responses.has(1) && responses.has(2)) {
          handshakeMs = Math.round(performance.now() - t0);
        }
        if (!finished && wantedIds.every((id) => responses.has(id))) {
          finished = true;
          clearTimeout(timer);
          child.once("close", () => resolveProbe({ responses, handshakeMs }));
          child.stdin.end();
          child.kill();
        }
      }
    });

    child.on("error", (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      rejectProbe(err);
    });

    child.stdin.write(`${requests.map((r) => JSON.stringify(r)).join("\n")}\n`);
  });
}

function toolResult(response: Record<string, unknown> | undefined): { text: string; isError: boolean } {
  const result = response?.result as { content?: Array<{ text?: string }>; isError?: boolean } | undefined;
  return { text: result?.content?.[0]?.text ?? "", isError: result?.isError === true };
}

export async function runDoctor(
  options: { json?: boolean; homeDir?: string; apps?: boolean } = {},
): Promise<DoctorReport> {
  const majorNode = Number(process.versions.node.split(".")[0] ?? "0");
  const checks: DoctorCheck[] = [
    { name: "Node.js >= 22", ok: majorNode >= 22, detail: `v${process.versions.node}` },
  ];

  let rgVersion: string | null = null;
  try {
    const { stdout } = await execFileAsync("rg", ["--version"], { timeout: 3000 });
    rgVersion = stdout.split(/\r?\n/)[0]?.trim() || "installed";
  } catch {
    rgVersion = null;
  }
  checks.push({
    name: "ripgrep",
    ok: true,
    warn: rgVersion === null,
    detail: rgVersion ?? "not found: using the slower built-in search",
  });

  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "turnpack-doc-")));
  const workspace = path.join(sandbox, "workspace");
  let schemaBytes = 0;
  let handshakeMs = 0;
  let batchIsolation: BatchIsolation | null = null;

  try {
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, ".env"), "TOKEN=SECRET_VAL\n");
    fs.writeFileSync(path.join(workspace, "a.js"), "export function a() { return 1; }\n");
    fs.writeFileSync(path.join(sandbox, "outside.txt"), "OUTSIDE_VAL\n");

    const call = (id: number, name: string, args: Record<string, unknown>): Record<string, unknown> => ({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    });
    const probe = await mcpLoopback(workspace, [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "turnpack-doctor" } },
      },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      call(3, "pack", { files: [".env"] }),
      call(4, "pack", { root: sandbox, files: ["outside.txt"] }),
      call(5, "pack", { files: ["../outside.txt"] }),
    ]);
    handshakeMs = probe.handshakeMs;

    const tools = (probe.responses.get(2)?.result as { tools?: Array<{ name?: string }> } | undefined)?.tools ?? [];
    const toolNames = tools.map((t) => String(t.name ?? ""));
    schemaBytes = Buffer.byteLength(JSON.stringify(tools), "utf8");
    const schemaTokens = Math.ceil(schemaBytes / 4);

    checks.push({
      name: "MCP handshake + tools",
      ok: toolNames.join(",") === "pack,ship,batch",
      detail: `${toolNames.join(", ")} (${handshakeMs}ms)`,
    });
    checks.push({
      name: "Schema budget (< 1,500 tok)",
      ok: schemaTokens < 1500,
      detail: `${schemaBytes} bytes (~${schemaTokens} tokens)`,
    });

    const envRead = toolResult(probe.responses.get(3));
    const shieldOk = envRead.text.includes("REDACTED SECRET FILE") && !envRead.text.includes("SECRET_VAL");
    checks.push({
      name: "Secret shield",
      ok: shieldOk,
      detail: shieldOk ? "active (.env read blocked)" : "FAILED: .env contents were returned",
    });

    const rootEscape = toolResult(probe.responses.get(4));
    const pathEscape = toolResult(probe.responses.get(5));
    const jailOk =
      rootEscape.isError &&
      rootEscape.text.includes("ERR_ROOT_OUTSIDE_WORKSPACE") &&
      pathEscape.text.includes("ERR_PATH_OUTSIDE_WORKSPACE") &&
      !rootEscape.text.includes("OUTSIDE_VAL") &&
      !pathEscape.text.includes("OUTSIDE_VAL");
    checks.push({
      name: "Workspace jail",
      ok: jailOk,
      detail: jailOk ? "holds (root override and ../ refused)" : "FAILED: read a file outside the workspace",
    });

    try {
      const marker = path.join(sandbox, "written-by-batch.txt");
      const batch = await runBatchDetailed({
        cwd: workspace,
        code: "let escaped = false; try { ctx.files.constructor('return process')(); escaped = true; } catch (e) {} return { files: ctx.files().length, escaped };",
      });
      batchIsolation = batch.isolation;
      const sealed = batch.text.includes('"escaped": false') && !fs.existsSync(marker);
      checks.push({
        name: "batch isolation",
        ok: sealed,
        warn: sealed && batch.isolation !== "permission",
        detail: !sealed
          ? "FAILED: script reached the host process"
          : batch.isolation === "permission"
            ? "own process, no writes, no exec"
            : "own process only (permission model unavailable)",
      });
    } catch (err) {
      checks.push({
        name: "batch isolation",
        ok: false,
        detail: `runner failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
      });
    }
  } catch (err) {
    checks.push({
      name: "MCP handshake + tools",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  } finally {
    await removeTempDir(sandbox);
  }

  let apps: AppCheck[] = [];
  if (options.apps !== false) {
    try {
      apps = await checkApps(options.homeDir ?? os.homedir());
    } catch {
      apps = [];
    }
  }

  const report: DoctorReport = {
    ok: checks.every((c) => c.ok) && apps.every((app) => app.state !== "failed"),
    nodeVersion: `v${process.versions.node}`,
    ripgrepVersion: rgVersion,
    schemaBytes,
    estimatedSchemaTokens: Math.ceil(schemaBytes / 4),
    handshakeMs,
    batchIsolation,
    checks,
    apps,
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report;
  }

  const out: string[] = ["", bold("turnpack doctor"), rule(80)];
  for (const check of report.checks) {
    const tag = !check.ok ? red("FAIL") : check.warn ? yellow("warn") : green("ok  ");
    out.push(`  [${tag}] ${check.name.padEnd(28)} ${check.detail}`);
  }
  out.push(rule(80));
  if (apps.length > 0) {
    out.push(`  ${bold("Your AI apps")}`);
    for (const app of apps) {
      const tag =
        app.state === "ready"
          ? app.warn
            ? yellow("warn")
            : green("ok  ")
          : app.state === "not-configured"
            ? dim(" -- ")
            : red("FAIL");
      const name = app.client.replace(/ \(.*\)$/, "").replace(/ MCP$/, "");
      out.push(`  [${tag}] ${name.padEnd(34)} ${app.detail}`);
    }
    out.push(rule(80));
  }
  const fencesOk = checks.every((c) => c.ok);
  const broken = apps.filter((app) => app.state === "failed" || app.state === "unreadable");
  const ready = apps.filter((app) => app.state === "ready");
  const missing = apps.filter((app) => app.state === "not-configured");
  out.push(
    !fencesOk
      ? `  ${red("Some checks failed.")} Please open an issue and paste this output.`
      : broken.length > 0
        ? `  ${red(`${broken.length} app(s) cannot start Turnpack.`)} Fix: ${bold("npx turnpack init")}`
        : ready.length > 0 && missing.length === 0
          ? `  ${green("All checks passed.")} Turnpack is ready in ${ready.length} app(s). Restart an app after any change.`
          : `  ${green("All checks passed.")} Next: ${bold("npx turnpack init")}`,
  );
  out.push("");
  process.stdout.write(`${out.join("\n")}\n`);
  return report;
}
