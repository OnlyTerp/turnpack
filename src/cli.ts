#!/usr/bin/env node
import { runAudit } from "./cli/audit.js";
import { runDemo } from "./cli/demo.js";
import { runDoctor } from "./cli/doctor.js";
import { runEstimate } from "./cli/estimate.js";
import { runInstaller } from "./cli/installer.js";
import { startMcpServer } from "./mcp-server.js";

function printHelp(): void {
  process.stdout.write(`
turnpack v0.1.0 — Fewer back-and-forth AI turns.
Local MCP context pack + test-gated multi-file ship with automatic rollback.

Quickstart (no API keys required):
  npx turnpack demo       Run a safe 1-second live sandbox walkthrough (0 repo changes)
  npx turnpack init       Preview diff & wire Turnpack into Claude Code, Codex CLI, or OMP
  npx turnpack doctor     Verify Node.js, compact MCP schema tokens, and .env secret shield
  npx turnpack estimate   See how much daily/weekly AI waiting time fewer turns save
  npx turnpack audit      Read-only scan of your local AI MCP configurations
  npx turnpack uninstall  Cleanly remove only Turnpack entries from your configs
  npx turnpack serve      Start the stdio MCP server (used automatically by your AI app)

Examples:
  npx turnpack init --yes
  npx turnpack init --client cursor --experimental --yes
  npx turnpack estimate --profile high-ttft
  npx turnpack estimate --ttft 15 --tps 20
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

  if (cmd === "--version" || cmd === "-v") {
    process.stdout.write("0.1.0\n");
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

void main();
