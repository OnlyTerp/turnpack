import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { runBatch, runPack } from "../dist/index.js";

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
    fs.rmSync(path.dirname(repoDir), { recursive: true, force: true });
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

  it("pack allows explicit allow_secrets override when intentional", async () => {
    const out = await runPack({
      root: repoDir,
      files: [".env"],
      allow_secrets: true,
      inline_only: true,
    });
    assert.match(out, /super_secret_do_not_leak/);
  });

  it("pack spills oversized responses to private shard files cleanly", async () => {
    const out = await runPack(
      { root: repoDir, files: ["src/big.txt"], max_bytes: 5000 },
      { clientName: "claude-code", maxInlineBytes: 5000, readToolHint: "Read" },
    );
    assert.match(out, /^PACK COMPILED/);
    assert.match(out, /Read shards in parallel with Read:/);
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
});
