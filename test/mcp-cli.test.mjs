import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import {
  SERVER_INSTRUCTIONS,
  TOOLS,
  VERSION,
  resolveClientContext,
  serverCommand,
} from "../dist/index.js";
import { appTargets, readConfiguredLaunch, stableNodePath } from "../dist/cli/installer.js";
import { CLI_PATH, removeDir, startSession, trySymlink, wait } from "./helpers.mjs";

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

  after(() => removeDir(fakeHome));

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

    // --no-apps: the fences are this test's subject, not whatever AI apps the machine has.
    const docJson = JSON.parse(
      execFileSync(process.execPath, [CLI_PATH, "doctor", "--json", "--no-apps"], { encoding: "utf8" }),
    );
    assert.deepEqual(docJson.apps, []);
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

  after(() => removeDir(base));

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

  it("keeps its guarantees when a call narrows its root to a sensitive directory", async () => {
    const repo = path.join(base, "narrow");
    fs.mkdirSync(path.join(repo, ".git", "hooks"), { recursive: true });
    fs.mkdirSync(path.join(repo, ".aws"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".git", "config"), "[remote]\n\turl = https://user:GIT_TOKEN_VALUE@example.com/r.git\n");
    fs.writeFileSync(path.join(repo, ".aws", "credentials"), "aws_secret_access_key = AWS_SECRET_VALUE\n");

    const session = startSession({ cwd: repo });
    try {
      await session.initialize();

      // Naming ".git" as cwd must not turn "hooks/pre-commit" into an ordinary file.
      const hook = await session.call("ship", {
        cwd: ".git",
        writes: [{ path: "hooks/pre-commit", content: "#!/bin/sh\necho owned\n" }],
      });
      assert.equal(hook.isError, true);
      assert.match(hook.text, /is protected/);
      assert.deepEqual(fs.readdirSync(path.join(repo, ".git", "hooks")), []);

      // Nor may it turn ".git/config" or ".aws/credentials" into unshielded bare names.
      for (const [root, file, secret] of [
        [".git", "config", "GIT_TOKEN_VALUE"],
        [".aws", "credentials", "AWS_SECRET_VALUE"],
      ]) {
        const viaPack = await session.call("pack", { root, files: [file], query: "VALUE" });
        assert.match(viaPack.text, /REDACTED SECRET FILE/);
        assert.equal(viaPack.text.includes(secret), false, viaPack.text);

        const viaBatch = await session.call("batch", {
          cwd: root,
          code: `return { read: ctx.read(${JSON.stringify(file)}), listed: ctx.files(), hits: await ctx.grep("VALUE") };`,
        });
        assert.equal(viaBatch.text.includes(secret), false, viaBatch.text);
      }
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

  it("uses CLAUDE_PROJECT_DIR when Claude names the project that way, and only then", async () => {
    const session = startSession({ cwd: outside, env: { CLAUDE_PROJECT_DIR: workspace } });
    try {
      await session.initialize({ clientInfo: { name: "claude-code", version: "2.1.280" } });
      const inside = await session.call("pack", { files: ["a.txt"] });
      assert.match(inside.text, /inside-a/);
      const launchDir = await session.call("pack", { root: outside, files: ["secret.txt"] });
      assert.match(launchDir.text, /ERR_ROOT_OUTSIDE_WORKSPACE/);
    } finally {
      await session.close();
    }

    // Another app started from a Claude Code terminal inherits the variable. For that app it
    // names somebody else's project, so the directory it was started in is the workspace.
    const inherited = startSession({ cwd: outside, env: { CLAUDE_PROJECT_DIR: workspace } });
    try {
      await inherited.initialize({ clientInfo: { name: "codex-mcp-client", version: "0.166.0" } });
      const own = await inherited.call("pack", { files: ["secret.txt"] });
      assert.match(own.text, /outside-secret/);
      const other = await inherited.call("pack", { root: workspace, files: ["a.txt"] });
      assert.match(other.text, /ERR_ROOT_OUTSIDE_WORKSPACE/);
    } finally {
      await inherited.close();
    }
  });

  it("has no workspace when started in the home directory: each call names its project and is confined to it", async () => {
    // Desktop chat apps start their servers in the home directory or the app's own folder.
    const fakeHome = path.join(base, "home");
    fs.mkdirSync(path.join(fakeHome, ".ssh"), { recursive: true });
    fs.writeFileSync(path.join(fakeHome, "notes.txt"), "home-notes\n");
    const session = startSession({ cwd: fakeHome, env: { HOME: fakeHome, USERPROFILE: fakeHome } });
    try {
      const init = await session.initialize();
      assert.match(init.result.instructions, /not started inside a project: pass `root`/);

      const tools = (await session.request("tools/list")).result.tools;
      for (const tool of tools) {
        assert.ok(tool.inputSchema.required.includes("root"), tool.name);
        assert.match(tool.inputSchema.properties.root.description, /Absolute path of the project directory/);
      }

      // Nothing is read from the home directory by default, and it cannot be named either.
      const unnamed = await session.call("pack", { files: ["notes.txt"] });
      assert.equal(unnamed.isError, true);
      assert.match(unnamed.text, /ERR_NO_WORKSPACE/);
      assert.equal(unnamed.text.includes("home-notes"), false);
      for (const [root, expected] of [
        [fakeHome, /ERR_ROOT_TOO_BROAD/],
        [path.join(fakeHome, ".ssh"), /ERR_ROOT_TOO_BROAD/],
        [path.parse(fakeHome).root, /ERR_ROOT_TOO_BROAD/],
        ["workspace", /ERR_NO_WORKSPACE/],
        [path.join(base, "does-not-exist"), /ERR_ROOT_NOT_A_DIRECTORY/],
      ]) {
        const refused = await session.call("pack", { root, files: ["notes.txt"] });
        assert.match(refused.text, expected, String(root));
        assert.equal(refused.text.includes("home-notes"), false);
      }

      // A named project works, under either argument name, and the call cannot leave it.
      const named = await session.call("pack", { root: workspace, files: ["a.txt", "../outside/secret.txt"] });
      assert.match(named.text, /inside-a/);
      assert.match(named.text, /ERR_PATH_OUTSIDE_WORKSPACE/);
      assert.equal(named.text.includes("outside-secret"), false);
      const viaBatch = await session.call("batch", { cwd: workspace, code: "return ctx.read('a.txt').trim();" });
      assert.match(viaBatch.text, /inside-a/);

      // Naming a subdirectory is not a way out from under the project's verify allowlist.
      fs.writeFileSync(
        path.join(workspace, ".turnpack.json"),
        JSON.stringify({ enforceVerifyAllowlist: true, allowedVerify: ["node -e 0"] }),
      );
      try {
        const smuggled = await session.call("ship", {
          root: path.join(workspace, "sub"),
          writes: [{ path: "made.txt", content: "x" }],
          verify: ["node -e 1"],
        });
        assert.match(smuggled.text, /ABORTED_BEFORE_WRITE[\s\S]*not in \.turnpack\.json allowedVerify/);
        assert.equal(fs.existsSync(path.join(workspace, "sub", "made.txt")), false);
      } finally {
        fs.rmSync(path.join(workspace, ".turnpack.json"), { force: true });
      }
    } finally {
      await session.close();
    }

    // A client that reports its folders gets a workspace from them, and is not asked for root.
    const withRoots = startSession({
      cwd: fakeHome,
      env: { HOME: fakeHome, USERPROFILE: fakeHome },
      onServerRequest: (msg) =>
        msg.method === "roots/list" ? { roots: [{ uri: pathToFileURL(workspace).href }] } : undefined,
    });
    try {
      const init = await withRoots.initialize({ capabilities: { roots: {} } });
      assert.doesNotMatch(init.result.instructions, /not started inside a project/);
      withRoots.notify("notifications/initialized");
      const tools = (await withRoots.request("tools/list")).result.tools;
      assert.equal(tools.some((tool) => (tool.inputSchema.required ?? []).includes("root")), false);
      assert.match((await withRoots.call("pack", { files: ["a.txt"] })).text, /inside-a/);
    } finally {
      await withRoots.close();
    }
  });

  it("describes its tools with plain types only, and still accepts the richer shapes", async () => {
    // Unions are dropped or rejected by several model APIs, so the schema must not need them.
    const walk = (node, where) => {
      if (Array.isArray(node)) return node.forEach((item, i) => walk(item, `${where}[${i}]`));
      if (!node || typeof node !== "object") return;
      for (const banned of ["oneOf", "anyOf", "allOf", "not", "$ref"]) {
        assert.equal(banned in node, false, `${where} uses ${banned}`);
      }
      if ("type" in node && where.endsWith(".properties") === false) {
        assert.equal(typeof node.type, "string", `${where}.type must be one type`);
      }
      for (const [key, value] of Object.entries(node)) walk(value, `${where}.${key}`);
    };
    for (const tool of TOOLS) walk(tool.inputSchema, tool.name);

    const session = startSession({ cwd: workspace });
    try {
      await session.initialize();
      const asObject = await session.call("pack", { files: [{ path: "a.txt", start_line: 1, end_line: 1 }] });
      assert.match(asObject.text, /inside-a/);
      const asText = await session.call("pack", { files: JSON.stringify(["a.txt", "sub/b.txt"]) });
      assert.match(asText.text, /inside-a[\s\S]*inside-b/);
      const oneCommand = await session.call("ship", {
        writes: [{ path: "sub/made.txt", content: "x\n" }],
        verify: "node -e 0",
      });
      assert.match(oneCommand.text, /SHIPPED_AND_VERIFIED/);
      fs.rmSync(path.join(workspace, "sub", "made.txt"), { force: true });
    } finally {
      await session.close();
    }
  });

  it("names the project's check in its instructions and reports progress while verify runs", async () => {
    const project = path.join(base, "node-project");
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ scripts: { test: "node -e 0" } }));
    const session = startSession({ cwd: project });
    try {
      const init = await session.initialize();
      assert.ok(init.result.instructions.startsWith(SERVER_INSTRUCTIONS));
      assert.match(init.result.instructions, /This project's check: `npm test` \(from package\.json\)\. Use it as ship's verify\./);

      const reply = await session.request("tools/call", {
        name: "ship",
        arguments: { writes: [{ path: "x.txt", content: "x\n" }], verify: ["node -e 0"] },
        _meta: { progressToken: "tok-1" },
      });
      assert.match(reply.result.content[0].text, /SHIPPED_AND_VERIFIED/);
      const progress = session.unsolicited.filter((msg) => msg.method === "notifications/progress");
      assert.ok(progress.length >= 1);
      assert.equal(progress[0].params.progressToken, "tok-1");
      assert.match(progress[0].params.message, /running node -e 0/);

      // No token, no notifications.
      const before = session.unsolicited.length;
      await session.call("ship", { writes: [{ path: "y.txt", content: "y\n" }], verify: ["node -e 0"] });
      assert.equal(session.unsolicited.length, before);
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

  it("applies the workspace's verify allowlist even when a call names a subdirectory as cwd", async () => {
    const guarded = path.join(base, "guarded");
    fs.mkdirSync(path.join(guarded, "pkg", "inner"), { recursive: true });
    fs.writeFileSync(
      path.join(guarded, ".turnpack.json"),
      JSON.stringify({ enforceVerifyAllowlist: true, allowedVerify: ["node ok.mjs"] }),
    );
    fs.writeFileSync(path.join(guarded, "ok.mjs"), "process.exit(0);\n");
    fs.writeFileSync(path.join(guarded, "pkg", "inner", "ok.mjs"), "process.exit(0);\n");
    const marker = path.join(guarded, "pkg", "inner", "ran.txt");
    const smuggle = "node -e \"require('fs').writeFileSync('ran.txt','x')\"";

    const session = startSession({ cwd: guarded });
    try {
      await session.initialize();

      // Stepping into a subdirectory must not step out from under the root's allowlist.
      const fromSub = await session.call("ship", { cwd: "pkg/inner", verify: smuggle });
      assert.equal(fromSub.isError, true);
      assert.match(fromSub.text, /not in \.turnpack\.json allowedVerify/);
      assert.equal(fs.existsSync(marker), false);

      // Nor may a call plant a permissive config of its own further down.
      const plant = await session.call("ship", {
        writes: [{ path: "pkg/inner/.turnpack.json", content: "{}" }],
      });
      assert.match(plant.text, /is protected/);

      // An allowed command plus an argument that redirects it is not the allowed command.
      const redirected = await session.call("ship", { verify: "node ok.mjs --prefix pkg/inner" });
      assert.match(redirected.text, /not in \.turnpack\.json allowedVerify/);

      const allowed = await session.call("ship", { cwd: "pkg/inner", verify: "node ok.mjs" });
      assert.match(allowed.text, /SHIPPED_AND_VERIFIED/);
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

  after(() => removeDir(home));

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

  it("writes a local, absolute launch by default, and a pinned npx one on request", () => {
    // The npx form names the exact version, so a later release cannot change what an app runs.
    const pinned = `turnpack@${PACKAGE_JSON.version}`;
    assert.deepEqual(serverCommand("linux"), { command: "npx", args: ["-y", pinned, "serve"] });
    assert.deepEqual(serverCommand("darwin"), { command: "npx", args: ["-y", pinned, "serve"] });
    assert.deepEqual(serverCommand("win32"), { command: "cmd", args: ["/c", "npx", "-y", pinned, "serve"] });

    const codexToml = path.join(home, ".codex", "config.toml");
    fs.mkdirSync(path.dirname(codexToml), { recursive: true });
    fs.rmSync(codexToml, { force: true });

    // Default: this machine's Node and this build's cli.js, both by absolute path.
    const out = run("init", "--client", "codex", "--yes");
    assert.match(out, /Checked: the server starts with that command \(\d+ ms, version [\d.]+, tools: pack, ship, batch\)/);
    const local = readConfiguredLaunch(appTargets(home).find((t) => t.key === "codex"));
    assert.equal(path.isAbsolute(local.command), true);
    assert.equal(fs.realpathSync(local.command), fs.realpathSync(process.execPath));
    assert.deepEqual(local.args, [CLI_PATH, "serve"]);
    // Room for a verify command that takes longer than these apps' 60-second default.
    assert.match(fs.readFileSync(codexToml, "utf8"), /startup_timeout_sec = 20\r?\ntool_timeout_sec = 600/);

    // --no-check: the package is not fetched from npm during the tests.
    run("init", "--client", "codex", "--npx", "--yes", "--no-check");
    assert.deepEqual(readConfiguredLaunch(appTargets(home).find((t) => t.key === "codex")), serverCommand());
    assert.equal((fs.readFileSync(codexToml, "utf8").match(/\[mcp_servers\.turnpack\]/g) ?? []).length, 1);

    // A Node on PATH that is the running one is preferred; one in a temporary directory is not.
    assert.equal(fs.realpathSync(stableNodePath()), fs.realpathSync(process.execPath));
    const shimDir = path.join(home, "shim");
    fs.mkdirSync(shimDir, { recursive: true });
    if (trySymlink(process.execPath, path.join(shimDir, process.platform === "win32" ? "node.exe" : "node"))) {
      assert.equal(stableNodePath(process.execPath, shimDir), process.execPath);
    }
  });

  it("copies the server's files to a durable place when asked, and removes them on uninstall", () => {
    const claudePath = path.join(home, ".claude.json");
    fs.writeFileSync(claudePath, "{}\n");
    const versionDir = path.join(home, ".turnpack", "versions", PACKAGE_JSON.version);

    const out = run("init", "--client", "claude", "--copy", "--yes");
    assert.match(out, /\[CREATE\s*\] Turnpack server files/);
    assert.match(out, /Checked: the server starts/);
    const entry = JSON.parse(fs.readFileSync(claudePath, "utf8")).mcpServers.turnpack;
    assert.deepEqual(entry.args, [path.join(versionDir, "dist", "cli.js"), "serve"]);
    assert.equal(entry.type, "stdio");
    for (const rel of ["package.json", "LICENSE", "NOTICE", "dist/cli.js", "dist/tools/batch-runner.js", "extensions/omp-turnpack.ts"]) {
      assert.equal(fs.existsSync(path.join(versionDir, rel)), true, rel);
    }
    assert.deepEqual(fs.readdirSync(path.dirname(versionDir)), [PACKAGE_JSON.version]);

    assert.match(run("init", "--client", "claude", "--copy", "--yes"), /already clean and up to date/);

    run("uninstall", "--yes");
    assert.equal(fs.existsSync(path.join(home, ".turnpack")), false);
    assert.equal(fs.readFileSync(claudePath, "utf8"), "{}\n".replace("{}", '{\n  "mcpServers": {}\n}'));
  });

  it("keeps what you added to an entry, and removes every trace on uninstall", () => {
    const codexToml = path.join(home, ".codex", "config.toml");
    const before = [
      'model = "gpt-test"',
      "",
      "[mcp_servers.other]",
      'command = "other"',
      "",
      "[mcp_servers.turnpack]",
      'command = "npx"',
      "args = [",
      '    "-y",',
      '    "turnpack",',
      '    "serve",',
      "]",
      'default_tools_approval_mode = "approve"',
      "tool_timeout_sec = 1200",
      "",
      "[mcp_servers.turnpack.env]",
      'KEEP_ME = "1"',
      "",
      "[mcp_servers.turnpack.tools.ship]",
      'approval_mode = "prompt"',
      "",
      "[tui]",
      "theme = 'dark'",
      "",
    ].join("\r\n");
    fs.mkdirSync(path.dirname(codexToml), { recursive: true });
    fs.writeFileSync(codexToml, before);

    run("init", "--client", "codex", "--yes");
    const after = fs.readFileSync(codexToml, "utf8");
    assert.equal(after.includes("\n") && !/[^\r]\n/.test(after), true, "CRLF line endings are kept");
    // Your own timeout wins over init's default; the one you did not set gets the default.
    assert.equal(after.includes("tool_timeout_sec = 600"), false);
    for (const kept of ["tool_timeout_sec = 1200", "startup_timeout_sec = 20", 'default_tools_approval_mode = "approve"', 'KEEP_ME = "1"', 'approval_mode = "prompt"', "theme = 'dark'", 'command = "other"']) {
      assert.equal(after.includes(kept), true, kept);
    }
    assert.equal(after.includes('"turnpack",'), false, "the old multi-line args are gone");
    for (const table of ["[mcp_servers.turnpack]", "[mcp_servers.turnpack.env]", "[mcp_servers.turnpack.tools.ship]"]) {
      assert.equal(after.split(table).length, 2, `${table} appears once`);
    }

    run("uninstall", "--client", "codex", "--yes");
    assert.equal(
      fs.readFileSync(codexToml, "utf8"),
      ['model = "gpt-test"', "", "[mcp_servers.other]", 'command = "other"', "", "[tui]", "theme = 'dark'", ""].join("\r\n"),
    );

    // The same for a JSON entry: extra keys survive, and the launch is replaced.
    const claudePath = path.join(home, ".claude.json");
    fs.writeFileSync(
      claudePath,
      JSON.stringify({ mcpServers: { turnpack: { command: "npx", args: ["turnpack"], alwaysLoad: true, env: { KEEP: "1" } } } }, null, "\t"),
    );
    run("init", "--client", "claude", "--yes");
    const text = fs.readFileSync(claudePath, "utf8");
    assert.match(text, /^\{\n\t"mcpServers"/, "tab indentation is kept");
    const entry = JSON.parse(text).mcpServers.turnpack;
    assert.deepEqual([entry.alwaysLoad, entry.env, entry.type, entry.args[1]], [true, { KEEP: "1" }, "stdio", "serve"]);
  });

  it("configures Claude Desktop and Grok, and pins a folder only for a named app", () => {
    const desktopDir =
      process.platform === "win32"
        ? path.join(home, "AppData", "Roaming", "Claude")
        : process.platform === "darwin"
          ? path.join(home, "Library", "Application Support", "Claude")
          : path.join(home, ".config", "Claude");
    fs.mkdirSync(desktopDir, { recursive: true });
    fs.mkdirSync(path.join(home, ".grok"), { recursive: true });
    const project = path.join(home, "my-project");
    fs.mkdirSync(project);

    const out = run("init", "--yes");
    assert.match(out, /Claude Desktop -> /);
    assert.match(out, /Grok Build \(grok CLI\) -> /);
    assert.match(out, /Claude Desktop chats have no project folder/);
    const desktopConfig = path.join(desktopDir, "claude_desktop_config.json");
    assert.equal("env" in JSON.parse(fs.readFileSync(desktopConfig, "utf8")).mcpServers.turnpack, false);
    assert.match(fs.readFileSync(path.join(home, ".grok", "config.toml"), "utf8"), /\[mcp_servers\.turnpack\][\s\S]*enabled = true\r?\nstartup_timeout_sec = 20/);

    // A pinned folder would apply to every session of an app, so it needs the app's name.
    assert.throws(() => run("init", "--root", project, "--yes"), /--root pins one folder for every session/);
    assert.throws(() => run("init", "--client", "claude-desktop", "--root", path.join(home, "nope"), "--yes"), /is not an existing folder/);
    run("init", "--client", "claude-desktop", "--root", project, "--yes");
    assert.deepEqual(JSON.parse(fs.readFileSync(desktopConfig, "utf8")).mcpServers.turnpack.env, {
      TURNPACK_ROOT: fs.realpathSync(project),
    });
    // The codex config written earlier was not given the folder.
    assert.equal(fs.existsSync(path.join(home, ".codex", "config.toml")) && fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8").includes("TURNPACK_ROOT"), false);
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
    assert.deepEqual(written.mcpServers.turnpack, { type: "stdio", command: stableNodePath(), args: [CLI_PATH, "serve"] });
    assert.equal(fs.readFileSync(`${claudePath}.turnpack.bak`, "utf8"), original);
    assert.equal(fs.existsSync(`${claudePath}.turnpack.tmp`), false);

    const again = run("init", "--client", "claude", "--yes");
    assert.match(again, /already clean and up to date/);

    // Uninstall puts the file back byte for byte, not merely to equivalent JSON.
    run("uninstall", "--client", "claude", "--yes");
    assert.equal(fs.readFileSync(claudePath, "utf8"), original);
  });

  it("doctor starts each app's configured server and says which apps are ready", () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "turnpack-doc-home-"));
    try {
      const doctor = () => {
        try {
          return { code: 0, out: execFileSync(process.execPath, [CLI_PATH, "doctor", "--json", "--home", fresh], { encoding: "utf8" }) };
        } catch (err) {
          return { code: err.status, out: String(err.stdout) };
        }
      };
      // Three apps installed: one will be configured, one left alone, one configured badly.
      fs.writeFileSync(path.join(fresh, ".claude.json"), "{}\n");
      fs.mkdirSync(path.join(fresh, ".codex"));
      fs.mkdirSync(path.join(fresh, ".cursor"));
      execFileSync(process.execPath, [CLI_PATH, "init", "--client", "claude", "--yes", "--home", fresh], { encoding: "utf8" });

      const healthy = doctor();
      const apps = Object.fromEntries(JSON.parse(healthy.out).apps.map((app) => [app.client, app]));
      assert.equal(healthy.code, 0);
      assert.equal(apps["Claude Code"].state, "ready");
      assert.match(apps["Claude Code"].detail, /starts in \d+ ms/);
      assert.equal(apps["Codex CLI and ChatGPT desktop app"].state, "not-configured");

      fs.writeFileSync(
        path.join(fresh, ".cursor", "mcp.json"),
        JSON.stringify({ mcpServers: { turnpack: { command: "turnpack-no-such-program", args: ["serve"] } } }),
      );
      const broken = doctor();
      const report = JSON.parse(broken.out);
      assert.equal(broken.code, 1);
      assert.equal(report.ok, false);
      const cursor = report.apps.find((app) => app.client.startsWith("Cursor"));
      assert.equal(cursor.state, "failed");
      assert.match(cursor.detail, /"turnpack-no-such-program" was not found, so the app cannot start it/);
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });
});

describe("Claude Desktop bundle", () => {
  it("is a readable zip whose manifest starts the server it contains", async () => {
    const zlib = await import("node:zlib");
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "turnpack-mcpb-"));
    try {
      const script = path.resolve(import.meta.dirname, "..", "scripts", "build-mcpb.mjs");
      execFileSync(process.execPath, [script, "--out", outDir], { encoding: "utf8" });
      const zip = fs.readFileSync(path.join(outDir, "turnpack.mcpb"));

      // Read the archive back the way any unzip tool does: from the directory at its end.
      const end = zip.length - 22;
      assert.equal(zip.readUInt32LE(end), 0x06054b50);
      const count = zip.readUInt16LE(end + 10);
      let at = zip.readUInt32LE(end + 16);
      const files = new Map();
      for (let i = 0; i < count; i++) {
        assert.equal(zip.readUInt32LE(at), 0x02014b50);
        const packedSize = zip.readUInt32LE(at + 20);
        const nameLength = zip.readUInt16LE(at + 28);
        const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
        const local = zip.readUInt32LE(at + 42);
        const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
        const data = zlib.inflateRawSync(zip.subarray(dataStart, dataStart + packedSize));
        // zlib.crc32 arrived in Node 22.2; inflating without an error is the check before that.
        if (typeof zlib.crc32 === "function") assert.equal(zlib.crc32(data), zip.readUInt32LE(at + 16), name);
        files.set(name, data);
        at += 46 + nameLength;
      }

      const manifest = JSON.parse(files.get("manifest.json").toString("utf8"));
      assert.equal(manifest.manifest_version, "0.3");
      assert.equal(manifest.version, PACKAGE_JSON.version);
      assert.deepEqual(manifest.tools.map((tool) => tool.name), ["pack", "ship", "batch"]);
      assert.equal(manifest.user_config.project_folder.type, "directory");
      assert.equal(manifest.server.mcp_config.env.TURNPACK_ROOT, "${user_config.project_folder}");
      // Everything the manifest starts, and everything the server loads later, is inside.
      const entry = manifest.server.mcp_config.args[0].replace("${__dirname}/", "");
      assert.equal(manifest.license, PACKAGE_JSON.license);
      for (const needed of [entry, "package.json", "LICENSE", "NOTICE", "dist/mcp-server.js", "dist/tools/batch-runner.js", "dist/search-worker.js"]) {
        assert.equal(files.has(needed), true, needed);
      }
      assert.deepEqual(files.get("dist/cli.js"), fs.readFileSync(CLI_PATH));
      assert.equal([...files.keys()].some((name) => name.endsWith(".d.ts") || name.includes("\\")), false);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});

describe("optional Claude Code hook", () => {
  const HOOK = path.resolve(import.meta.dirname, "..", "extensions", "claude-hook.mjs");
  const fire = (tool, session, command) =>
    execFileSync(process.execPath, [HOOK], {
      input: JSON.stringify({ tool_name: tool, session_id: session, ...(command ? { tool_input: { command } } : {}) }),
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

  it("counts reads and searches made through the shell, but not other commands", () => {
    // Where Claude Code has no Grep or Glob tool, searching is a shell command.
    const session = `test-shell-${process.pid}-${Date.now()}`;
    try {
      assert.equal(fire("Bash", session, "rg -n calculateTax src"), "");
      assert.equal(fire("Bash", session, "npm test"), "");
      assert.equal(fire("Bash", session, "cd src && cat tax.js"), "");
      assert.equal(fire("PowerShell", session, "Get-Content src/invoice.js"), "");
      assert.equal(fire("Bash", session, "git commit -m 'grep is only a word here'"), "");
      const spoken = JSON.parse(fire("Bash", session, "grep -rn computeTax ."));
      assert.match(spoken.hookSpecificOutput.additionalContext, /mcp__turnpack__ship/);
    } finally {
      fs.rmSync(path.join(os.tmpdir(), `turnpack-hook-${session}.json`), { force: true });
    }
  });

  it("never fails a tool call on bad input", () => {
    assert.equal(execFileSync(process.execPath, [HOOK], { input: "not json", encoding: "utf8" }), "");
    assert.equal(execFileSync(process.execPath, [HOOK], { input: "", encoding: "utf8" }), "");
  });
});

