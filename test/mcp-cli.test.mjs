import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { SERVER_INSTRUCTIONS, TOOLS, VERSION, resolveClientContext } from "../dist/index.js";
import { CLI_PATH, startSession, wait } from "./helpers.mjs";

const PACKAGE_JSON = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, "..", "package.json"), "utf8"),
);

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
    assert.deepEqual(
      demoJson.steps.map((step) => step.tool),
      ["pack", "ship", "ship", "batch", "fences"],
    );

    assert.equal(
      execFileSync(process.execPath, [CLI_PATH, "--version"], { encoding: "utf8" }).trim(),
      PACKAGE_JSON.version,
    );

    const docJson = JSON.parse(
      execFileSync(process.execPath, [CLI_PATH, "doctor", "--json"], { encoding: "utf8" }),
    );
    assert.equal(docJson.ok, true, JSON.stringify(docJson.checks));
    assert.equal(docJson.estimatedSchemaTokens < 1500, true);
    assert.deepEqual(
      docJson.checks.map((check) => check.name),
      [
        "Node.js >= 22",
        "ripgrep",
        "MCP handshake + tools",
        "Schema budget (< 1,500 tok)",
        "Secret shield",
        "Workspace jail",
        "batch isolation",
      ],
    );

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

describe("MCP protocol behaviour", () => {
  let base;
  let workspace;
  let outside;

  before(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "turnpack-mcp-")));
    workspace = path.join(base, "workspace");
    outside = path.join(base, "outside");
    fs.mkdirSync(path.join(workspace, "sub"), { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(workspace, "a.txt"), "inside-a\n");
    fs.writeFileSync(path.join(workspace, "sub", "b.txt"), "inside-b\n");
    fs.writeFileSync(path.join(outside, "secret.txt"), "outside-secret\n");
  });

  after(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("reports the package.json version, negotiates the protocol, and sends usage instructions", async () => {
    const session = startSession({ cwd: workspace });
    try {
      const known = await session.initialize({ protocolVersion: "2024-11-05" });
      assert.equal(known.result.protocolVersion, "2024-11-05");
      assert.equal(known.result.serverInfo.version, PACKAGE_JSON.version);
      assert.equal(VERSION, PACKAGE_JSON.version);
      assert.equal(known.result.instructions, SERVER_INSTRUCTIONS);
      assert.match(known.result.instructions, /`pack`[\s\S]*`ship`[\s\S]*`batch`/);

      const unknown = await session.initialize({ protocolVersion: "1999-01-01" });
      assert.equal(unknown.result.protocolVersion, "2025-06-18");
    } finally {
      await session.close();
    }
  });

  it("marks pack and batch read-only, ship destructive, and stays inside the schema budget", async () => {
    const session = startSession({ cwd: workspace });
    try {
      await session.initialize();
      const listed = (await session.request("tools/list")).result.tools;
      const byName = Object.fromEntries(listed.map((tool) => [tool.name, tool]));
      assert.equal(byName.pack.annotations.readOnlyHint, true);
      assert.equal(byName.batch.annotations.readOnlyHint, true);
      assert.equal(byName.ship.annotations.readOnlyHint, false);
      assert.equal(byName.ship.annotations.destructiveHint, true);
      assert.equal(Buffer.byteLength(JSON.stringify(listed), "utf8") < 5500, true);
    } finally {
      await session.close();
    }
  });

  it("stops advertising batch as read-only when the operator enables ctx.exec", async () => {
    const session = startSession({ cwd: workspace, env: { TURNPACK_ALLOW_EXEC: "1" } });
    try {
      await session.initialize();
      const listed = (await session.request("tools/list")).result.tools;
      const batch = listed.find((tool) => tool.name === "batch");
      assert.equal(batch.annotations.readOnlyHint, false);
      assert.match(batch.description, /ctx\.exec\(command\) is enabled/);
    } finally {
      await session.close();
    }
  });

  it("confines every tool to the directory the server was started in", async () => {
    const session = startSession({ cwd: workspace });
    try {
      await session.initialize();

      const viaRoot = await session.call("pack", { root: outside, files: ["secret.txt"] });
      assert.equal(viaRoot.isError, true);
      assert.match(viaRoot.text, /ERR_ROOT_OUTSIDE_WORKSPACE/);
      assert.equal(viaRoot.text.includes("outside-secret"), false);

      const viaParent = await session.call("pack", { root: "..", files: ["outside/secret.txt"] });
      assert.match(viaParent.text, /ERR_ROOT_OUTSIDE_WORKSPACE/);

      const viaFile = await session.call("pack", { files: ["../outside/secret.txt"] });
      assert.match(viaFile.text, /ERR_PATH_OUTSIDE_WORKSPACE/);
      assert.equal(viaFile.text.includes("outside-secret"), false);

      const shipOut = await session.call("ship", {
        cwd: outside,
        writes: [{ path: "planted.txt", content: "x" }],
      });
      assert.equal(shipOut.isError, true);
      assert.match(shipOut.text, /ERR_ROOT_OUTSIDE_WORKSPACE/);
      assert.equal(fs.existsSync(path.join(outside, "planted.txt")), false);

      const batchOut = await session.call("batch", { cwd: outside, code: "return ctx.files()" });
      assert.equal(batchOut.isError, true);
      assert.match(batchOut.text, /ERR_ROOT_OUTSIDE_WORKSPACE/);

      // A subdirectory of the workspace is a legitimate narrower root.
      const sub = await session.call("pack", { root: "sub", files: ["b.txt"] });
      assert.equal(sub.isError, false);
      assert.match(sub.text, /inside-b/);
    } finally {
      await session.close();
    }
  });

  it("honours TURNPACK_ROOT over the launch directory", async () => {
    const session = startSession({ cwd: outside, env: { TURNPACK_ROOT: workspace } });
    try {
      await session.initialize();
      const inside = await session.call("pack", { files: ["a.txt"] });
      assert.match(inside.text, /inside-a/);
      const launchDir = await session.call("pack", { root: outside, files: ["secret.txt"] });
      assert.match(launchDir.text, /ERR_ROOT_OUTSIDE_WORKSPACE/);
    } finally {
      await session.close();
    }
  });

  it("uses CLAUDE_PROJECT_DIR when the launching app names the project that way", async () => {
    const session = startSession({ cwd: outside, env: { CLAUDE_PROJECT_DIR: workspace } });
    try {
      await session.initialize();
      const inside = await session.call("pack", { files: ["a.txt"] });
      assert.match(inside.text, /inside-a/);
      const launchDir = await session.call("pack", { root: outside, files: ["secret.txt"] });
      assert.match(launchDir.text, /ERR_ROOT_OUTSIDE_WORKSPACE/);
    } finally {
      await session.close();
    }
  });

  it("adopts the folders an MCP client reports through roots/list", async () => {
    const asked = [];
    const session = startSession({
      cwd: outside,
      onServerRequest: (msg) => {
        asked.push(msg.method);
        return msg.method === "roots/list"
          ? { roots: [{ uri: pathToFileURL(workspace).href, name: "workspace" }] }
          : undefined;
      },
    });
    try {
      await session.initialize({ capabilities: { roots: { listChanged: true } } });
      session.notify("notifications/initialized");

      const inside = await session.call("pack", { files: ["a.txt"] });
      assert.deepEqual(asked, ["roots/list"]);
      assert.match(inside.text, /inside-a/);

      const launchDir = await session.call("pack", { root: outside, files: ["secret.txt"] });
      assert.match(launchDir.text, /ERR_ROOT_OUTSIDE_WORKSPACE/);
    } finally {
      await session.close();
    }
  });

  it("answers malformed input with JSON-RPC errors instead of silence or a crash", async () => {
    const session = startSession({ cwd: workspace });
    try {
      await session.initialize();

      const unknownTool = await session.request("tools/call", { name: "nope", arguments: {} });
      assert.equal(unknownTool.error.code, -32602);

      const unknownMethod = await session.request("does/not/exist");
      assert.equal(unknownMethod.error.code, -32601);

      const badArgs = await session.call("pack", "not-an-object");
      assert.equal(badArgs.isError, true);

      const wrongType = await session.call("pack", { files: 42 });
      assert.equal(wrongType.isError, true);
      assert.match(wrongType.text, /pack\.files must be an array/);

      // A lone string where a list is expected is the most common model slip; accept it.
      const lenient = await session.call("pack", { files: "a.txt" });
      assert.equal(lenient.isError, false);
      assert.match(lenient.text, /inside-a/);

      session.sendRaw("{ this is not json\n");
      session.notify("notifications/cancelled", { requestId: 1 });
      await wait(150);
      assert.equal(session.unsolicited.length, 1);
      assert.equal(session.unsolicited[0].error.code, -32700);
      assert.equal(session.unsolicited[0].id, null);

      const stillAlive = await session.request("ping");
      assert.deepEqual(stillAlive.result, {});
    } finally {
      await session.close();
    }
  });

  it("runs ship calls one at a time so concurrent ships cannot interleave", async () => {
    fs.writeFileSync(path.join(workspace, "counter.txt"), "0\n");
    const session = startSession({ cwd: workspace });
    try {
      await session.initialize();
      const verify =
        "node -e \"const fs=require('fs');const v=fs.readFileSync('counter.txt','utf8');setTimeout(()=>process.exit(v.trim().length?0:1),150)\"";
      const [first, second] = await Promise.all([
        session.call("ship", { edits: [{ path: "counter.txt", search: "0", replace: "1" }], verify }),
        session.call("ship", { edits: [{ path: "counter.txt", search: "1", replace: "2" }], verify }),
      ]);
      assert.match(first.text, /SHIPPED_AND_VERIFIED/);
      assert.match(second.text, /SHIPPED_AND_VERIFIED/);
      assert.equal(fs.readFileSync(path.join(workspace, "counter.txt"), "utf8"), "2\n");
    } finally {
      await session.close();
    }
  });
});

describe("installer safety", () => {
  let home;

  before(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "turnpack-inst-"));
  });

  after(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  const run = (...args) =>
    execFileSync(process.execPath, [CLI_PATH, ...args, "--home", home], { encoding: "utf8" });

  it("leaves a config it cannot parse untouched and still configures the others", () => {
    const withComments = '{\n  // my servers\n  "mcpServers": { "keep": { "command": "echo" } }\n}\n';
    fs.mkdirSync(path.join(home, ".cursor"), { recursive: true });
    fs.writeFileSync(path.join(home, ".cursor", "mcp.json"), withComments);
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });

    const out = run("init", "--experimental", "--yes");
    assert.match(out, /\[SKIPPED\s*\] Cursor/);
    assert.match(out, /Left untouched: not plain JSON/);
    assert.equal(fs.readFileSync(path.join(home, ".cursor", "mcp.json"), "utf8"), withComments);
    assert.equal(fs.existsSync(path.join(home, ".cursor", "mcp.json.turnpack.bak")), false);
    assert.match(fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8"), /\[mcp_servers\.turnpack\]/);
  });

  it("previews without writing on --dry-run, backs up before writing, and is idempotent", () => {
    const claudePath = path.join(home, ".claude.json");
    const original = `${JSON.stringify({ numStartups: 7, mcpServers: { keep: { command: "echo" } } }, null, 2)}\n`;
    fs.writeFileSync(claudePath, original);

    const preview = run("init", "--client", "claude", "--dry-run");
    assert.match(preview, /Dry run complete/);
    assert.equal(fs.readFileSync(claudePath, "utf8"), original);

    run("init", "--client", "claude", "--yes");
    const written = JSON.parse(fs.readFileSync(claudePath, "utf8"));
    assert.equal(written.numStartups, 7);
    assert.deepEqual(written.mcpServers.keep, { command: "echo" });
    assert.deepEqual(written.mcpServers.turnpack, { command: "npx", args: ["-y", "turnpack", "serve"] });
    assert.equal(fs.readFileSync(`${claudePath}.turnpack.bak`, "utf8"), original);
    assert.equal(fs.existsSync(`${claudePath}.turnpack.tmp`), false);

    const again = run("init", "--client", "claude", "--yes");
    assert.match(again, /already clean and up to date/);

    run("uninstall", "--client", "claude", "--yes");
    assert.deepEqual(JSON.parse(fs.readFileSync(claudePath, "utf8")), JSON.parse(original));
  });
});

describe("optional Claude Code hook", () => {
  const HOOK = path.resolve(import.meta.dirname, "..", "extensions", "claude-hook.mjs");
  const fire = (tool, session) =>
    execFileSync(process.execPath, [HOOK], {
      input: JSON.stringify({ tool_name: tool, session_id: session }),
      encoding: "utf8",
    });

  it("stays silent on ordinary calls and speaks once per burst, in the documented JSON form", () => {
    const session = `test-${process.pid}-${Date.now()}`;
    try {
      assert.equal(fire("Read", session), "");
      assert.equal(fire("Grep", session), "");
      assert.equal(fire("Bash", session), "");
      assert.equal(fire("Read", session), "");

      const spoken = JSON.parse(fire("Edit", session));
      assert.equal(spoken.hookSpecificOutput.hookEventName, "PreToolUse");
      assert.match(spoken.hookSpecificOutput.additionalContext, /mcp__turnpack__pack/);

      // The counter starts over, so the very next call is quiet again.
      assert.equal(fire("Read", session), "");
      assert.equal(fire("Read", session), "");
      assert.equal(fire("mcp__turnpack__pack", session), "");
      assert.equal(fire("Read", session), "");
      assert.equal(fire("Read", session), "");
      assert.equal(fire("Read", session), "");
    } finally {
      fs.rmSync(path.join(os.tmpdir(), `turnpack-hook-${session}.json`), { force: true });
    }
  });

  it("never fails a tool call on bad input", () => {
    assert.equal(execFileSync(process.execPath, [HOOK], { input: "not json", encoding: "utf8" }), "");
    assert.equal(execFileSync(process.execPath, [HOOK], { input: "", encoding: "utf8" }), "");
  });
});

