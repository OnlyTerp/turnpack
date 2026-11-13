#!/usr/bin/env node
// Model-in-the-loop benchmark: the same task, through an agent CLI you already have installed,
// with and without Turnpack. It answers the two questions the engine timings cannot:
// does the model actually reach for the tools, and what does that change?
//
//   node bench/agent-bench.mjs --agents claude,codex --arms native,turnpack --runs 3
//
// Every run gets a freshly generated project in a scratch directory. Nothing in your own
// projects or AI app configs is read or changed: Turnpack is handed to each CLI through a flag
// or a file inside the scratch project. Each run is a real session on your account and costs
// what a small task costs.
//
// See bench/README.md for how to read the output, and for what this does not measure.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPO, "dist", "cli.js");
const NODE = process.execPath;

function option(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at !== -1 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}
const AGENTS = option("agents", "claude,codex").split(",").map((s) => s.trim()).filter(Boolean);
const ARMS = option("arms", "native,turnpack").split(",").map((s) => s.trim()).filter(Boolean);
const RUNS = Math.max(1, Number(option("runs", "1")) || 1);
const TIMEOUT_MS = Math.max(30, Number(option("timeout", "360")) || 360) * 1000;
const OUT_DIR = path.resolve(option("out", path.join(os.tmpdir(), `turnpack-agent-bench-${Date.now().toString(36)}`)));
const CLAUDE_MODEL = option("claude-model", "sonnet");
const CODEX_EFFORT = option("codex-effort", "low");
// Codex runs the model's shell commands in a sandbox. Where that sandbox cannot start processes
// in the scratch directory (seen on Windows with a scratch drive), the native arm cannot run
// the tests at all; "danger-full-access" removes the sandbox for these throwaway runs.
const CODEX_SANDBOX = option("codex-sandbox", "workspace-write");

// ---------------------------------------------------------------------------------------------
// The task
// ---------------------------------------------------------------------------------------------

const TASK =
  "Rename the function calculateTax to computeTax everywhere in this project: its definition, every import and every call. Then run the tests and make sure they pass.";
// Arm 2 of the protocol: the same agent, merely asked to batch. It separates what the tools do
// from what asking does.
const BATCH_HINT =
  " Work in as few steps as you can: read everything you need at once, and make all the edits together.";

/** A small shop: one function used from four files, a test, and a few files that are noise. */
function writeFixture(dir) {
  const files = {
    "package.json": `${JSON.stringify({ name: "shop", version: "1.0.0", type: "module", private: true, scripts: { test: "node test/shop.test.js" } }, null, 2)}\n`,
    "README.md": "# shop\n\nA tiny order calculator. `npm test` runs the checks.\n",
    "src/tax.js": "export const TAX_RATE = 0.08;\n\nexport function calculateTax(amount) {\n  return Number((amount * TAX_RATE).toFixed(2));\n}\n",
    "src/invoice.js": 'import { calculateTax } from "./tax.js";\n\nexport function invoiceTotal(subtotal) {\n  return Number((subtotal + calculateTax(subtotal)).toFixed(2));\n}\n',
    "src/cart.js": 'import { calculateTax } from "./tax.js";\nimport { formatMoney } from "./format.js";\n\nexport function cartSummary(items) {\n  const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0);\n  const tax = calculateTax(subtotal);\n  return { subtotal, tax, label: formatMoney(subtotal + tax) };\n}\n',
    "src/report.js": 'import { calculateTax, TAX_RATE } from "./tax.js";\n\nexport function taxReport(amounts) {\n  return amounts.map((amount) => ({ amount, rate: TAX_RATE, tax: calculateTax(amount) }));\n}\n',
    "src/format.js": "export function formatMoney(value) {\n  return `$${value.toFixed(2)}`;\n}\n",
    "src/discount.js": "export function applyDiscount(amount, percent) {\n  return Number((amount * (1 - percent / 100)).toFixed(2));\n}\n",
    "test/shop.test.js": [
      'import assert from "node:assert/strict";',
      'import { invoiceTotal } from "../src/invoice.js";',
      'import { cartSummary } from "../src/cart.js";',
      'import { taxReport } from "../src/report.js";',
      'import { calculateTax } from "../src/tax.js";',
      "",
      "assert.equal(calculateTax(100), 8);",
      "assert.equal(invoiceTotal(100), 108);",
      'assert.equal(cartSummary([{ price: 10, qty: 5 }]).label, "$54.00");',
      "assert.equal(taxReport([50])[0].tax, 4);",
      'console.log("ok - shop totals include tax");',
      "",
    ].join("\n"),
  };
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

/** Checked by this script after the agent stops, so the agent cannot talk its way to a pass. */
function solved(dir) {
  const sources = ["src/tax.js", "src/invoice.js", "src/cart.js", "src/report.js", "test/shop.test.js"];
  for (const rel of sources) {
    let text;
    try {
      text = fs.readFileSync(path.join(dir, rel), "utf8");
    } catch {
      return { ok: false, why: `${rel} is missing` };
    }
    if (text.includes("calculateTax")) return { ok: false, why: `${rel} still says calculateTax` };
  }
  if (!/export function computeTax\(/.test(fs.readFileSync(path.join(dir, "src/tax.js"), "utf8"))) {
    return { ok: false, why: "src/tax.js does not export computeTax" };
  }
  const test = spawnSync(NODE, ["test/shop.test.js"], { cwd: dir, encoding: "utf8", windowsHide: true });
  return test.status === 0 ? { ok: true, why: "" } : { ok: false, why: "the tests fail" };
}

// ---------------------------------------------------------------------------------------------
// The agents
// ---------------------------------------------------------------------------------------------

function findOnPath(names) {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const name of names) {
      for (const ext of exts) {
        const candidate = path.join(dir, name + ext);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

/** npm installs CLIs as batch shims on Windows; a shim cannot be started without a shell. */
function claudeBinary() {
  const found = findOnPath(["claude"]);
  if (!found || !/\.cmd$/i.test(found)) return found;
  const exe = path.join(path.dirname(found), "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
  return fs.existsSync(exe) ? exe : null;
}

const tomlLiteral = (value) => `'${value}'`;

const ADAPTERS = {
  claude: {
    binary: claudeBinary,
    prepare({ dir, arm, logFile }) {
      const servers = arm === "turnpack" ? { turnpack: { command: NODE, args: [CLI, "serve"], env: { TURNPACK_LOG: logFile } } } : {};
      const mcpConfig = path.join(dir, "..", "mcp.json");
      fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: servers }));
      const tools = ["Read", "Edit", "Write", "Glob", "Grep", "Bash"];
      if (arm === "turnpack") tools.push("mcp__turnpack__pack", "mcp__turnpack__ship", "mcp__turnpack__batch");
      return {
        args: [
          "-p", "--output-format", "stream-json", "--verbose",
          "--model", CLAUDE_MODEL,
          // Only this run's servers and only the project's own settings: your global rules file
          // and your other MCP servers stay out of both arms.
          "--mcp-config", mcpConfig, "--strict-mcp-config", "--setting-sources", "project",
          "--allowedTools", tools.join(","),
        ],
        cwd: dir,
        stdin: true,
      };
    },
    parse(stdout) {
      const tools = {};
      let cost = null;
      let outputTokens = null;
      // One assistant message is one answer from the model, however many tool calls it holds.
      // That is a round trip. (The CLI's own num_turns counts each tool call, so it is not used.)
      const messages = new Set();
      for (const line of stdout.split("\n")) {
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type === "assistant") {
          if (event.message?.id) messages.add(event.message.id);
          for (const block of event.message?.content ?? []) {
            if (block.type === "tool_use") tools[block.name] = (tools[block.name] ?? 0) + 1;
          }
        }
        if (event.type === "result") {
          cost = event.total_cost_usd ?? null;
          outputTokens = event.usage?.output_tokens ?? null;
        }
      }
      return { tools, turns: messages.size, cost, outputTokens };
    },
  },

  codex: {
    binary: () => findOnPath(["codex"]),
    prepare({ dir, arm, logFile }) {
      const args = [
        "exec", "--json", "--skip-git-repo-check", "--ephemeral",
        // Neither arm sees your config.toml, your other MCP servers or your global AGENTS.md.
        "--ignore-user-config", "--ignore-rules",
        "-s", CODEX_SANDBOX, "-C", dir,
        "-c", `model_reasoning_effort=${tomlLiteral(CODEX_EFFORT)}`,
      ];
      if (process.platform === "win32") args.push("-c", "windows.sandbox='unelevated'");
      if (arm === "turnpack") {
        args.push(
          "-c", `mcp_servers.turnpack.command=${tomlLiteral(NODE)}`,
          "-c", `mcp_servers.turnpack.args=[${tomlLiteral(CLI)}, 'serve']`,
          "-c", `mcp_servers.turnpack.env.TURNPACK_LOG=${tomlLiteral(logFile)}`,
          "-c", "mcp_servers.turnpack.tool_timeout_sec=600",
          // A headless run has nobody to approve a tool call.
          "-c", "mcp_servers.turnpack.default_tools_approval_mode='approve'",
        );
      }
      args.push("-");
      return { args, cwd: path.dirname(dir), stdin: true };
    },
    parse(stdout) {
      const tools = {};
      let turns = 0;
      let outputTokens = 0;
      for (const line of stdout.split("\n")) {
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type === "item.completed" && event.item) {
          const item = event.item;
          const name =
            item.type === "mcp_tool_call" ? `mcp:${item.server ?? "?"}/${item.tool ?? "?"}` : item.type;
          if (item.type !== "agent_message" && item.type !== "reasoning") tools[name] = (tools[name] ?? 0) + 1;
        }
        if (event.type === "turn.completed") {
          turns += 1;
          outputTokens += event.usage?.output_tokens ?? 0;
        }
      }
      return { tools, turns: null, cost: null, outputTokens: outputTokens || null };
    },
  },

  omp: {
    binary: () => findOnPath(["omp"]),
    prepare({ dir, arm, logFile }) {
      if (arm === "turnpack") {
        fs.mkdirSync(path.join(dir, ".omp"), { recursive: true });
        fs.writeFileSync(
          path.join(dir, ".omp", "mcp.json"),
          JSON.stringify({ mcpServers: { turnpack: { type: "stdio", command: NODE, args: [CLI, "serve"], env: { TURNPACK_LOG: logFile }, timeout: 600000 } } }),
        );
      }
      // OMP has no switch that leaves out your own MCP servers and rules, so its two arms
      // differ by Turnpack but are not otherwise bare. Read its numbers with that in mind.
      return { args: ["-p", "--no-session", "--cwd", dir], cwd: path.dirname(dir), stdin: false, promptAsArg: true };
    },
    parse() {
      return { tools: {}, turns: null, cost: null, outputTokens: null };
    },
  },
};

function runAgent(binary, spec, prompt) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const args = spec.promptAsArg ? [...spec.args, prompt] : spec.args;
    const child = spawn(binary, args, {
      cwd: spec.cwd,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (how) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ how, seconds: (Date.now() - t0) / 1000, stdout, stderr });
    };
    const timer = setTimeout(() => {
      if (child.pid) {
        if (process.platform === "win32") {
          spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        } else {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            // Already gone.
          }
        }
      }
      finish("timeout");
    }, TIMEOUT_MS);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (err) => finish(`could not start: ${err.message}`));
    child.on("close", (code) => finish(code === 0 ? "exit" : `exit ${code}`));
    child.stdin.on("error", () => {});
    child.stdin.end(spec.stdin ? prompt : "");
  });
}

function readLog(logFile) {
  try {
    return fs
      .readFileSync(logFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function runOne(agent, arm, n) {
  const adapter = ADAPTERS[agent];
  const binary = adapter.binary();
  const runDir = path.join(OUT_DIR, `${agent}-${arm}-${n}`);
  const dir = path.join(runDir, "shop");
  fs.mkdirSync(dir, { recursive: true });
  writeFixture(dir);
  const logFile = path.join(runDir, "turnpack-calls.jsonl");
  if (!binary) return { agent, arm, n, skipped: `${agent} is not installed` };

  const spec = adapter.prepare({ dir, arm: arm === "prompt" ? "native" : arm, logFile });
  const prompt = arm === "prompt" ? TASK + BATCH_HINT : TASK;
  const run = await runAgent(binary, spec, prompt);
  fs.writeFileSync(path.join(runDir, "stdout.txt"), run.stdout);
  fs.writeFileSync(path.join(runDir, "stderr.txt"), run.stderr);

  const parsed = adapter.parse(run.stdout);
  const calls = readLog(logFile);
  const verdict = solved(dir);
  const toolCalls = Object.values(parsed.tools).reduce((sum, count) => sum + count, 0);
  return {
    agent,
    arm,
    n,
    how: run.how,
    solved: verdict.ok,
    why: verdict.why,
    seconds: Number(run.seconds.toFixed(1)),
    turns: parsed.turns,
    toolCalls: toolCalls || null,
    tools: parsed.tools,
    turnpackCalls: calls.map((call) => (call.status ? `${call.tool}:${call.status}` : call.tool)),
    outputTokens: parsed.outputTokens,
    cost: parsed.cost,
  };
}

function median(values) {
  const sorted = values.filter((v) => typeof v === "number").sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Number(((sorted[mid - 1] + sorted[mid]) / 2).toFixed(1));
}

if (!fs.existsSync(CLI)) {
  console.error("Build first: npm run build");
  process.exit(1);
}
fs.mkdirSync(OUT_DIR, { recursive: true });
console.log(`agents: ${AGENTS.join(", ")}   arms: ${ARMS.join(", ")}   runs each: ${RUNS}   output: ${OUT_DIR}`);
console.log(`task: ${TASK}\n`);

// Agents run side by side (they are different services); one agent's runs go one after another.
const results = (
  await Promise.all(
    AGENTS.filter((agent) => {
      if (ADAPTERS[agent]) return true;
      console.log(`unknown agent "${agent}" (known: ${Object.keys(ADAPTERS).join(", ")})`);
      return false;
    }).map(async (agent) => {
      const mine = [];
      for (let n = 1; n <= RUNS; n++) {
        for (const arm of ARMS) {
          const result = await runOne(agent, arm, n);
          mine.push(result);
          console.log(
            result.skipped
              ? `${agent} ${arm} #${n}: skipped (${result.skipped})`
              : `${agent} ${arm} #${n}: ${result.solved ? "solved" : `NOT solved (${result.why})`} in ${result.seconds}s` +
                  `${result.turns !== null ? `, ${result.turns} round trips` : ""}${result.toolCalls ? `, ${result.toolCalls} tool calls` : ""}` +
                  `${result.outputTokens ? `, ${result.outputTokens} output tokens` : ""}` +
                  `${result.turnpackCalls.length ? `, turnpack: ${result.turnpackCalls.join(" ")}` : arm === "turnpack" ? ", turnpack: NOT USED" : ""}` +
                  `${result.how === "exit" ? "" : ` [${result.how}]`}`,
          );
        }
      }
      return mine;
    }),
  )
).flat();

fs.writeFileSync(path.join(OUT_DIR, "results.json"), `${JSON.stringify(results, null, 2)}\n`);

console.log("\n| Agent | Arm | Solved | Time | Model round trips | Tool calls | Output tokens | Cost | Used Turnpack |");
console.log("| :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const agent of AGENTS) {
  for (const arm of ARMS) {
    const rows = results.filter((r) => r.agent === agent && r.arm === arm && !r.skipped);
    if (rows.length === 0) continue;
    const used = rows.filter((r) => r.turnpackCalls.length > 0).length;
    const cost = median(rows.map((r) => r.cost));
    console.log(
      `| ${agent} | ${arm} | ${rows.filter((r) => r.solved).length}/${rows.length} | ${median(rows.map((r) => r.seconds)) ?? "-"}s | ${median(rows.map((r) => r.turns)) ?? "-"} | ${median(rows.map((r) => r.toolCalls)) ?? "-"} | ${median(rows.map((r) => r.outputTokens)) ?? "-"} | ${cost === null ? "-" : `$${cost.toFixed(3)}`} | ${arm === "turnpack" ? `${used}/${rows.length}` : "-"} |`,
    );
  }
}
console.log("\nEvery figure is the median of that arm's runs. Raw output of every run is under " + OUT_DIR);
