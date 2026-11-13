import { spawn } from "node:child_process";

/** A command an AI app runs to start an MCP server, as it appears in that app's config. */
export interface LaunchSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface ProbeResult {
  ok: boolean;
  ms: number;
  /** The version the server reported about itself. */
  version?: string;
  tools: string[];
  error?: string;
}

/**
 * Starts a server exactly as an app would (no shell, the same command and arguments), performs
 * the MCP handshake, asks for its tools, and stops it. This is the difference between "the
 * config file has an entry" and "the entry works".
 */
export function probeLaunch(spec: LaunchSpec, cwd: string, timeoutMs = 15000): Promise<ProbeResult> {
  const t0 = performance.now();
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    // The probe must not inherit a workspace meant for whatever started this command.
    delete env.TURNPACK_ROOT;
    delete env.CLAUDE_PROJECT_DIR;
    Object.assign(env, spec.env ?? {});

    let settled = false;
    let stdout = "";
    let stderr = "";
    let version: string | undefined;
    const finish = (result: Omit<ProbeResult, "ms">): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.stdin?.end();
        child.kill();
      } catch {
        // Already gone.
      }
      resolve({ ...result, ms: Math.round(performance.now() - t0) });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(spec.command, spec.args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (err) {
      resolve({ ok: false, ms: 0, tools: [], error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const timer = setTimeout(
      () => finish({ ok: false, tools: [], error: `no answer within ${Math.round(timeoutMs / 1000)}s${stderr ? `: ${lastLine(stderr)}` : ""}` }),
      timeoutMs,
    );

    child.on("error", (err) => {
      const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
      finish({
        ok: false,
        tools: [],
        error: missing ? `"${spec.command}" was not found, so the app cannot start it` : err.message,
      });
    });
    child.on("close", (code) => {
      finish({ ok: false, tools: [], error: `exited with code ${code}${stderr ? `: ${lastLine(stderr)}` : ""}` });
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 8192) stderr += chunk.toString("utf8");
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      let nl: number;
      while ((nl = stdout.indexOf("\n")) !== -1) {
        const line = stdout.slice(0, nl).trim();
        stdout = stdout.slice(nl + 1);
        if (!line) continue;
        let msg: { id?: unknown; result?: { serverInfo?: { version?: string }; tools?: Array<{ name?: string }> } };
        try {
          msg = JSON.parse(line) as typeof msg;
        } catch {
          continue;
        }
        if (msg.id === 1) version = msg.result?.serverInfo?.version;
        if (msg.id === 2) {
          const tools = (msg.result?.tools ?? []).map((tool) => String(tool.name ?? ""));
          finish({ ok: tools.length > 0, version, tools, error: tools.length > 0 ? undefined : "the server listed no tools" });
        }
      }
    });
    child.stdin?.on("error", () => {
      // The process went away before reading; "close" reports it.
    });
    child.stdin?.write(
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "turnpack-probe" } } },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
      ]
        .map((msg) => JSON.stringify(msg))
        .join("\n") + "\n",
    );
  });
}

function lastLine(text: string): string {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  return (lines[lines.length - 1] ?? "").slice(0, 200);
}
