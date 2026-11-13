#!/usr/bin/env node
import { runAudit } from "./cli/audit.js";
import { runDemo } from "./cli/demo.js";
import { runDoctor } from "./cli/doctor.js";
import { runEstimate } from "./cli/estimate.js";
import { runInstaller } from "./cli/installer.js";
import { startMcpServer } from "./mcp-server.js";
import { VERSION } from "./version.js";

function printHelp(): void {
  process.stdout.write(`
turnpack v${VERSION} — fewer back-and-forth AI turns.
A local MCP server: gather context in one call, ship multi-file edits behind your tests.

Try it (no API keys, nothing of yours is touched):
  npx turnpack demo       Walk through pack, ship and batch in a throwaway temp repo
  npx turnpack doctor     Check Node, the MCP handshake, the secret shield and the sandbox

Set it up:
  npx turnpack init       Preview, then add Turnpack to Claude Code, Codex CLI or OMP
  npx turnpack audit      Read-only scan of the MCP servers your AI apps already load
  npx turnpack uninstall  Remove only the entries init added

Other:
  npx turnpack estimate   Model the waiting time saved by fewer round trips
  npx turnpack serve      Start the stdio MCP server (your AI app runs this for you)

Examples:
  npx turnpack init --dry-run
  npx turnpack init --client cursor --yes
  npx turnpack estimate --ttft 2 --tok-per-turn 300 --tps 40

Docs: https://github.com/OnlyTerp/turnpack
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const rest = args.slice(1);

  if (cmd === "serve" || cmd === "mcp" || (!cmd && !process.stdin.isTTY)) {
    startMcpServer();
    return;
  }

  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    printHelp();
    return;
  }

  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  if (cmd === "demo") {
    const report = await runDemo({ json: rest.includes("--json") });
    if (!report.ok) process.exitCode = 1;
    return;
  }

  if (cmd === "doctor") {
    const report = await runDoctor({ json: rest.includes("--json") });
    if (!report.ok) process.exitCode = 1;
    return;
  }

  if (cmd === "estimate") {
    runEstimate(rest);
    return;
  }

  if (cmd === "audit") {
    runAudit(rest);
    return;
  }

  if (cmd === "init") {
    await runInstaller("init", rest);
    return;
  }

  if (cmd === "uninstall") {
    await runInstaller("uninstall", rest);
    return;
  }

  process.stderr.write(`Unknown command: ${cmd}\nRun "turnpack --help" for usage.\n`);
  process.exitCode = 1;
}

main().catch((err: unknown) => {
  process.stderr.write(`turnpack: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
