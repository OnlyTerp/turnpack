import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { runBatch, runBatchDetailed, runPack } from "../dist/index.js";
import { removeDir } from "./helpers.mjs";

describe("pack and read-only batch", () => {
  let repoDir;
  let cacheDir;
  let prevCache;

  before(() => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "turnpack-pb-"));
    repoDir = path.join(base, "repo");
    cacheDir = path.join(base, "cache");
    prevCache = process.env.TURNPACK_CACHE_DIR;
    process.env.TURNPACK_CACHE_DIR = cacheDir;

    fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, ".env"), "API_TOKEN=super_secret_do_not_leak\n");
    fs.writeFileSync(path.join(repoDir, ".env.example"), "API_TOKEN=your_key_here\n");
    fs.writeFileSync(
      path.join(repoDir, "src", "math.ts"),
      [
        "export function add(a: number, b: number): number {",
        "  return a + b;",
        "}",
        "",
        "export function multiply(a: number, b: number): number {",
        "  return a * b;",
        "}",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(repoDir, "src", "big.txt"), `${"line-of-context-".repeat(60)}\n`.repeat(120));
  });

  after(() => {
    if (prevCache === undefined) delete process.env.TURNPACK_CACHE_DIR;
    else process.env.TURNPACK_CACHE_DIR = prevCache;
    return removeDir(path.dirname(repoDir));
  });

  it("pack bundles search, symbol slice, globs and redacts secrets by default", async () => {
    const out = await runPack({
      root: repoDir,
      query: "API_TOKEN|multiply",
      files: [{ path: "src/math.ts", symbol: "multiply" }, ".env", ".env.example"],
      globs: ["src/*.ts"],
      inline_only: true,
    });

    assert.match(out, /SYMBOL: src\/math\.ts :: function multiply/);
    assert.match(out, /return a \* b;/);
    assert.match(out, /REDACTED SECRET FILE: \.env/);
    assert.equal(out.includes("super_secret_do_not_leak"), false);
    assert.match(out, /your_key_here/);
  });

  it("pack slices one symbol out of Python, Rust and Go files", async () => {
    fs.writeFileSync(
      path.join(repoDir, "src", "svc.py"),
      "import os\n\nclass Service:\n    def start(self):\n        return 1\n\n    def stop(self):\n        return 0\n\ndef helper():\n    return None\n",
    );
    fs.writeFileSync(
      path.join(repoDir, "src", "lib.rs"),
      "pub struct Config {\n    pub port: u16,\n}\n\npub async fn serve(cfg: Config) -> u16 {\n    cfg.port\n}\n",
    );
    fs.writeFileSync(
      path.join(repoDir, "src", "main.go"),
      "package main\n\ntype Server struct {\n\tport int\n}\n\nfunc (s *Server) Listen() int {\n\treturn s.port\n}\n\nfunc main() {\n\tprintln(1)\n}\n",
    );
    const out = await runPack({
      root: repoDir,
      files: [
        { path: "src/svc.py", symbol: "stop" },
        { path: "src/lib.rs", symbol: "serve" },
        { path: "src/main.go", symbol: "Listen" },
        { path: "src/main.go", symbol: "Server" },
        { path: "src/main.go", symbol: "nope" },
      ],
      inline_only: true,
    });
    assert.match(out, /SYMBOL: src\/svc\.py :: def stop \(L7-8\/12\)\n7 \|     def stop\(self\):\n8 \|         return 0/);
    assert.match(out, /SYMBOL: src\/lib\.rs :: fn serve \(L5-7\/8\)/);
    assert.match(out, /SYMBOL: src\/main\.go :: func Listen \(L7-9\/14\)\n7 \| func \(s \*Server\) Listen\(\) int \{/);
    assert.match(out, /SYMBOL: src\/main\.go :: type Server \(L3-5\/14\)/);
    assert.match(out, /SYMBOL NOT FOUND: available: Server:3, Listen:7, main:11/);
  });

  it("pack allows explicit allow_secrets override when intentional", async () => {
    const out = await runPack({
      root: repoDir,
      files: [".env"],
      allow_secrets: true,
      inline_only: true,
    });
    assert.match(out, /super_secret_do_not_leak/);
  });

  it("pack keeps what fits inline and spills only the overflow to private shard files", async () => {
    const out = await runPack(
      { root: repoDir, query: "multiply", files: ["src/big.txt"], max_bytes: 5000 },
      { clientName: "claude-code", maxInlineBytes: 5000, readToolHint: "Read" },
    );
    // The small search section still arrives inline; only the oversized file is moved out.
    assert.match(out, /^## SEARCH "multiply"/);
    assert.match(out, /src\/math\.ts:5: export function multiply/);
    assert.match(out, /## OVERFLOW \(\d+ bytes total > 5000 inline cap for claude-code\)/);
    assert.match(out, /read with Read only if needed/);
    assert.equal(Buffer.byteLength(out, "utf8") <= 5000, true);

    const shardPaths = [...out.matchAll(/FILES \(1\): (.+)$/gm)].map((m) => m[1]);
    assert.equal(shardPaths.length >= 2, true);
    for (const shard of shardPaths) {
      assert.equal(shard.startsWith(cacheDir), true);
      assert.equal(shard.startsWith(repoDir), false);
    }
    assert.match(fs.readFileSync(shardPaths[0], "utf8"), /^## FILES \(1\)\n### FILE: src\/big\.txt/);
  });

  it("pack treats a query that looks like a ripgrep flag as text to search for", async () => {
    fs.writeFileSync(path.join(repoDir, "src", "flags.md"), "Run with --pre=sh or --files to debug.\n");
    fs.writeFileSync(path.join(repoDir, "run-me.sh"), `#!/bin/sh\necho injected > "${path.join(repoDir, "INJECTED")}"\n`);

    // Passed as a bare argument, ripgrep read these as its own options: "--pre=sh" (an option
    // that runs a command per file) stalled the search for 10s, "--files" returned nothing.
    const pre = await runPack({ root: repoDir, query: "--pre=sh", literal: true, inline_only: true });
    assert.match(pre, /src\/flags\.md:1: Run with --pre=sh/);
    assert.equal(fs.existsSync(path.join(repoDir, "INJECTED")), false);

    const files = await runPack({ root: repoDir, query: "--files", inline_only: true });
    assert.match(files, /\(1 hits/);
    assert.match(files, /src\/flags\.md:1:/);
  });

  it("pack reports a bad path without losing the other files in the same call", async () => {
    const out = await runPack({
      root: repoDir,
      files: ["../../etc/passwd", "src/math.ts:1-3", "does/not/exist.ts"],
      inline_only: true,
    });
    assert.match(out, /BLOCKED: ERR_PATH_OUTSIDE_WORKSPACE/);
    assert.match(out, /export function add/);
    assert.match(out, /NOT FOUND: does\/not\/exist\.ts/);
  });

  it("pack falls back to the built-in search and explains an unusable regex", async () => {
    const prevPath = process.env.PATH;
    process.env.PATH = "";
    try {
      const found = await runPack({ root: repoDir, query: "function (add|multiply)", inline_only: true });
      assert.match(found, /engine=node/);
      assert.match(found, /src\/math\.ts:1: export function add/);
      assert.equal(found.includes("super_secret_do_not_leak"), false);

      const secretHit = await runPack({ root: repoDir, query: "API_TOKEN", inline_only: true });
      assert.match(secretHit, /REDACTED SECRET MATCHES in \.env/);
      assert.equal(secretHit.includes("super_secret_do_not_leak"), false);

      const broken = await runPack({ root: repoDir, query: "function (add", inline_only: true });
      assert.match(broken, /invalid regex/);
    } finally {
      process.env.PATH = prevPath;
    }
  });

  it("batch runs read-only repo helpers and blocks ctx.exec by default", async () => {
    const blocked = await runBatch({
      cwd: repoDir,
      code: `
        const files = ctx.files('**/*.ts');
        const outline = ctx.outline('src/math.ts');
        let denied = false;
        try { await ctx.exec('echo hi'); } catch (e) { denied = String(e).includes('ERR_EXEC_DISABLED'); }
        return { files, outlineNames: outline.map((s) => s.name), denied };
      `,
    });
    assert.match(blocked, /BATCH OK/);
    assert.match(blocked, /"denied": true/);
    assert.match(blocked, /"multiply"/);
  });

  it("batch permits ctx.exec only when TURNPACK_ALLOW_EXEC=1 is set", async () => {
    const prev = process.env.TURNPACK_ALLOW_EXEC;
    process.env.TURNPACK_ALLOW_EXEC = "1";
    try {
      const allowed = await runBatch({
        cwd: repoDir,
        code: `const res = await ctx.exec('node -e "process.stdout.write(String(6*7))"'); return res.stdout;`,
      });
      assert.match(allowed, /42/);
    } finally {
      if (prev === undefined) delete process.env.TURNPACK_ALLOW_EXEC;
      else process.env.TURNPACK_ALLOW_EXEC = prev;
    }
  });

  it("batch accepts a function, a plain body, and a body that starts with a helper function", async () => {
    const asArrow = await runBatch({ cwd: repoDir, code: "async (ctx) => ctx.files('src/*.ts').length" });
    assert.match(asArrow, /Result:\n1/);

    const asBody = await runBatch({ cwd: repoDir, code: "const hits = await ctx.grep('multiply'); return hits.length;" });
    assert.match(asBody, /Result:\n1/);

    const helperFirst = await runBatch({
      cwd: repoDir,
      code: "function names(f) { return ctx.outline(f).map((s) => s.name); }\nconsole.log('outlining');\nreturn names('src/math.ts');",
    });
    assert.match(helperFirst, /Logs:\noutlining/);
    assert.match(helperFirst, /"add"[\s\S]*"multiply"/);
  });

  it("batch cannot be escaped into the host process, the filesystem, or a shell", async () => {
    const marker = path.join(path.dirname(repoDir), "written-by-escape.txt");
    const out = await runBatch({
      cwd: repoDir,
      code: `
        const attempts = {
          hostFunction: () => ctx.files.constructor('return process')(),
          contextFunction: () => this.constructor.constructor('return process')(),
          resultObject: () => ctx.files().constructor.constructor('return process')(),
          thrownError: () => { try { ctx.read('../nope'); } catch (e) { return e.constructor.constructor('return process')(); } },
          promise: () => ctx.gitStatus().constructor.constructor('return process')(),
          evalCall: () => eval('process'),
        };
        const report = {};
        for (const [name, attempt] of Object.entries(attempts)) {
          try {
            const proc = attempt();
            if (proc && proc.pid) {
              proc.getBuiltinModule('node:fs').writeFileSync(${JSON.stringify(marker)}, 'escaped');
              report[name] = 'ESCAPED';
            } else {
              report[name] = 'no process';
            }
          } catch (e) {
            report[name] = 'blocked';
          }
        }
        try { await import('node:fs'); report.dynamicImport = 'IMPORTED'; }
        catch (e) {
          report.dynamicImport = 'blocked';
          try { if (e.constructor.constructor('return process')().pid) report.dynamicImport = 'ESCAPED'; } catch (_) {}
        }
        return report;
      `,
    });
    assert.equal(out.includes("ESCAPED"), false, out);
    assert.equal(out.includes("IMPORTED"), false, out);
    assert.equal(fs.existsSync(marker), false);
    for (const name of ["hostFunction", "contextFunction", "resultObject", "thrownError", "promise", "evalCall", "dynamicImport"]) {
      assert.match(out, new RegExp(`"${name}": "blocked"`));
    }
  });

  it("batch runs in a locked-down process: no secrets from the environment, reads stay in the workspace", async () => {
    const prev = process.env.TURNPACK_TEST_SECRET;
    process.env.TURNPACK_TEST_SECRET = "env_secret_value";
    try {
      const detailed = await runBatchDetailed({
        cwd: repoDir,
        code: `
          const outside = [];
          for (const target of ['../cache', '/etc/hostname', '.env']) {
            try { outside.push(ctx.read(target).slice(0, 40)); } catch (e) { outside.push('refused'); }
          }
          return { outside, env: typeof process };
        `,
      });
      assert.match(detailed.text, /"env": "undefined"/);
      assert.equal(detailed.text.includes("env_secret_value"), false);
      assert.match(detailed.text, /"refused",\s+"refused",\s+"\[REDACTED SECRET FILE: \.env\]"/);
      assert.equal(["permission", "process"].includes(detailed.isolation), true);
      if (process.allowedNodeEnvironmentFlags.has("--permission")) {
        assert.equal(detailed.isolation, "permission");
      }
    } finally {
      if (prev === undefined) delete process.env.TURNPACK_TEST_SECRET;
      else process.env.TURNPACK_TEST_SECRET = prev;
    }
  });

  it("batch kills runaway scripts, including loops that start after an await", async () => {
    const started = Date.now();
    await assert.rejects(
      runBatch({ cwd: repoDir, code: "while (true) {}", timeout_ms: 400 }),
      /batch timed out after 400ms/,
    );
    await assert.rejects(
      runBatch({ cwd: repoDir, code: "await ctx.gitStatus(); for (;;) {}", timeout_ms: 400 }),
      /batch timed out after 400ms/,
    );
    assert.equal(Date.now() - started < 5000, true);
  });

  it("batch leaves nothing holding the workspace once a call returns", async () => {
    // On Windows a live process pins its working directory. The runner must not sit in the
    // workspace, and must be gone by the time the call returns, or the folder cannot be removed.
    for (const [code, timeout] of [
      ["return ctx.files().length", 5000],
      ["while (true) {}", 400],
    ]) {
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "turnpack-pin-"));
      fs.writeFileSync(path.join(scratch, "a.js"), "export const a = 1;\n");
      await runBatch({ cwd: scratch, code, timeout_ms: timeout }).catch(() => {});
      fs.rmSync(scratch, { recursive: true });
      assert.equal(fs.existsSync(scratch), false);
    }
  });

  it("batch reports script errors and caps oversized results", async () => {
    await assert.rejects(runBatch({ cwd: repoDir, code: "return {{{" }), /batch script failed: SyntaxError/);
    await assert.rejects(
      runBatch({ cwd: repoDir, code: "console.log('before'); throw new TypeError('boom');" }),
      /batch script failed: TypeError: boom[\s\S]*Logs:\nbefore/,
    );
    await assert.rejects(runBatch({ cwd: repoDir }), /batch\.code must be a non-empty string/);

    const big = await runBatch({ cwd: repoDir, code: "return 'x'.repeat(200000);" });
    assert.match(big, /result truncated: 200000 bytes exceeds the 48000-byte cap/);
    assert.equal(Buffer.byteLength(big, "utf8") < 50000, true);
  });
});
