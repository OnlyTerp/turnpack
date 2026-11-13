import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { TOOLS, resolveClientContext } from "../dist/index.js";

const CLI_PATH = path.resolve(import.meta.dirname, "..", "dist", "cli.js");

function runFramedMcp(mode, messages) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, "serve"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let rx = Buffer.alloc(0);
    const results = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Timed out waiting for ${mode} MCP responses`));
    }, 5000);

    const checkDone = () => {
      if (results.length >= messages.length) {
        clearTimeout(timer);
        child.kill();
        resolve(results);
      }
    };

    child.stdout.on("data", (chunk) => {
      rx = Buffer.concat([rx, chunk]);
      if (mode === "content-length") {
        while (rx.length > 0) {
          const sep = rx.indexOf("\r\n\r\n");
          if (sep === -1) break;
          const hdr = rx.subarray(0, sep).toString("utf8");
          const m = /Content-Length:\s*(\d+)/i.exec(hdr);
          if (!m) break;
          const len = Number(m[1]);
          if (rx.length < sep + 4 + len) break;
          const body = rx.subarray(sep + 4, sep + 4 + len).toString("utf8");
          rx = rx.subarray(sep + 4 + len);
          results.push(JSON.parse(body));
        }
      } else {
        while (true) {
          const nl = rx.indexOf("\n");
          if (nl === -1) break;
          const line = rx.subarray(0, nl).toString("utf8").trim();
          rx = rx.subarray(nl + 1);
          if (line) results.push(JSON.parse(line));
        }
      }
      checkDone();
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    for (const msg of messages) {
      const json = JSON.stringify(msg);
      if (mode === "content-length") {
        const len = Buffer.byteLength(json, "utf8");
        child.stdin.write(`Content-Length: ${len}\r\n\r\n${json}`);
      } else {
        child.stdin.write(`${json}\n`);
      }
    }
  });
}

describe("MCP server framing, schema budget & CLI lifecycle", () => {
  let fakeHome;

  before(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "turnpack-home-"));
    fs.writeFileSync(
      path.join(fakeHome, ".claude.json"),
      JSON.stringify({ mcpServers: { existing_keep: { command: "echo", args: ["ok"] } } }, null, 2),
    );
    fs.mkdirSync(path.join(fakeHome, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(fakeHome, ".codex", "config.toml"),
      '[mcp_servers.sibling_tool]\ncommand = "node"\nargs = ["-v"]\n',
    );
    fs.mkdirSync(path.join(fakeHome, ".omp", "agent"), { recursive: true });
    fs.writeFileSync(
      path.join(fakeHome, ".omp", "agent", "mcp.json"),
      JSON.stringify({ mcpServers: { sibling: { command: "echo" } } }, null, 2),
    );
  });

  after(() => {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  it("keeps compact 3-tool MCP schema under 5500 bytes and sets client caps accurately", () => {
    const schemaBytes = Buffer.byteLength(JSON.stringify(TOOLS), "utf8");
    assert.equal(TOOLS.map((t) => t.name).join(","), "pack,ship,batch");
    assert.equal(schemaBytes < 5500, true, `Expected < 5500 bytes, got ${schemaBytes}`);

    assert.equal(resolveClientContext("claude-code").maxInlineBytes, 24000);
    assert.equal(resolveClientContext("codex-cli").maxInlineBytes, 32000);
    assert.equal(resolveClientContext("oh-my-pi").maxInlineBytes, 32000);
    assert.equal(resolveClientContext("cursor").maxInlineBytes, 20000);
  });

  it("serves stdio MCP over both NDJSON and Content-Length framing", async () => {
    const reqs = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "omp" } } },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ];

    const nd = await runFramedMcp("ndjson", reqs);
    assert.equal(nd[0]?.result?.serverInfo?.name, "turnpack");
    assert.equal(nd[1]?.result?.tools?.length, 3);

    const cl = await runFramedMcp("content-length", reqs);
    assert.equal(cl[0]?.result?.serverInfo?.name, "turnpack");
    assert.equal(cl[1]?.result?.tools?.length, 3);
  });

  it("completes idempotent init -> audit -> uninstall preserving sibling configs", () => {
    const initOut = execFileSync(process.execPath, [CLI_PATH, "init", "--home", fakeHome, "--yes"], {
      encoding: "utf8",
    });
    assert.match(initOut, /Claude Code/);
    assert.match(initOut, /Codex CLI/);
    assert.match(initOut, /OMP/);

    const auditJson = JSON.parse(
      execFileSync(process.execPath, [CLI_PATH, "audit", "--home", fakeHome, "--json"], {
        encoding: "utf8",
      }),
    );
    const claudeAudit = auditJson.findings.find((f) => f.client === "Claude Code");
    assert.equal(claudeAudit?.hasTurnpack, true);
    assert.equal(claudeAudit?.serverCount, 2);

    execFileSync(process.execPath, [CLI_PATH, "uninstall", "--home", fakeHome, "--yes"], {
      encoding: "utf8",
    });

    const claudeAfter = JSON.parse(fs.readFileSync(path.join(fakeHome, ".claude.json"), "utf8"));
    assert.ok(claudeAfter.mcpServers.existing_keep);
    assert.equal("turnpack" in claudeAfter.mcpServers, false);

    const codexAfter = fs.readFileSync(path.join(fakeHome, ".codex", "config.toml"), "utf8");
    assert.match(codexAfter, /\[mcp_servers\.sibling_tool\]/);
    assert.equal(/\[mcp_servers\.turnpack\]/.test(codexAfter), false);
    assert.equal(
      fs.existsSync(path.join(fakeHome, ".omp", "agent", "extensions", "turnpack.ts")),
      false,
    );
  });

  it("runs demo, doctor, and estimate commands cleanly", () => {
    const demoJson = JSON.parse(
      execFileSync(process.execPath, [CLI_PATH, "demo", "--json"], { encoding: "utf8" }),
    );
    assert.equal(demoJson.ok, true);
    assert.equal(demoJson.steps.length, 4);

    const docJson = JSON.parse(
      execFileSync(process.execPath, [CLI_PATH, "doctor", "--json"], { encoding: "utf8" }),
    );
    assert.equal(docJson.ok, true);
    assert.equal(docJson.estimatedSchemaTokens < 1500, true);

    const estJson = JSON.parse(
      execFileSync(
        process.execPath,
        [CLI_PATH, "estimate", "--prompts", "20", "--size", "medium", "--turn-sec", "8", "--json"],
        { encoding: "utf8" },
      ),
    );
    assert.equal(estJson.turnsSavedPerTask, 12);
    assert.equal(estJson.hoursSavedPerWeek, 2.7);

    const localProfile = JSON.parse(
      execFileSync(process.execPath, [CLI_PATH, "estimate", "--profile", "local", "--json"], {
        encoding: "utf8",
      }),
    );
    assert.equal(localProfile.input.ttftSeconds, 0.5);
    assert.equal(localProfile.input.streamSeconds, 11);
    assert.equal(localProfile.input.turnSeconds, 11.5);
    assert.equal(localProfile.hoursSavedPerWeek, 3.8);

    const highTtft = JSON.parse(
      execFileSync(
        process.execPath,
        [CLI_PATH, "estimate", "--profile", "high-ttft", "--json"],
        { encoding: "utf8" },
      ),
    );
    assert.equal(highTtft.input.turnSeconds, 35);
    assert.equal(highTtft.input.ttftSeconds, 15);
    assert.equal(highTtft.input.streamSeconds, 20);
    assert.equal(highTtft.hoursSavedPerWeek, 11.7);

    const coldCloud = JSON.parse(
      execFileSync(
        process.execPath,
        [CLI_PATH, "estimate", "--profile", "cold-cloud", "--json"],
        { encoding: "utf8" },
      ),
    );
    assert.equal(coldCloud.input.ttftSeconds, 25);
    assert.equal(coldCloud.input.streamSeconds, 25);
    assert.equal(coldCloud.input.turnSeconds, 50);
    assert.equal(coldCloud.hoursSavedPerWeek, 16.7);

    const customSubSec = JSON.parse(
      execFileSync(
        process.execPath,
        [CLI_PATH, "estimate", "--ttft", "0.2", "--tok-per-turn", "300", "--tps", "50", "--json"],
        { encoding: "utf8" },
      ),
    );
    assert.equal(customSubSec.input.ttftSeconds, 0.2);
    assert.equal(customSubSec.input.streamSeconds, 6);
    assert.equal(customSubSec.input.turnSeconds, 6.2);
  });
});
