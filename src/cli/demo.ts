import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runBatchDetailed } from "../tools/batch.js";
import { runPack } from "../tools/pack.js";
import { runShip } from "../tools/ship.js";
import { bold, cyan, dim, green, red, rule } from "./style.js";
import { removeTempDir } from "./tempdir.js";

export interface DemoStep {
  tool: string;
  name: string;
  passed: boolean;
  ms: number;
  /** What was asked of the tool. */
  did: string;
  /** What came back. */
  detail: string;
}

export interface DemoReport {
  ok: boolean;
  steps: DemoStep[];
  totalMs: number;
}

function sha256File(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

const VERIFY = "node test/invoice.test.mjs";
const DETAIL_WIDTH = 58;

export async function runDemo(options: { json?: boolean } = {}): Promise<DemoReport> {
  const tStart = performance.now();
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "turnpack-demo-")));
  const repo = path.join(sandbox, "repo");
  const steps: DemoStep[] = [];

  try {
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.mkdirSync(path.join(repo, "test"), { recursive: true });
    fs.mkdirSync(path.join(repo, ".git", "hooks"), { recursive: true });
    fs.writeFileSync(path.join(sandbox, "outside.txt"), "not part of the repo\n");

    fs.writeFileSync(path.join(repo, ".env"), "STRIPE_SECRET_KEY=sk_live_demo_redacted_123\n");
    fs.writeFileSync(path.join(repo, ".env.example"), "STRIPE_SECRET_KEY=replace_me\n");
    fs.writeFileSync(
      path.join(repo, "src", "tax.ts"),
      "export function calculateTax(amount: number): number {\n  return Number((amount * 0.08).toFixed(2));\n}\n",
    );
    fs.writeFileSync(
      path.join(repo, "src", "total.ts"),
      "import { calculateTax } from './tax.js';\nexport function invoiceTotal(subtotal: number): number {\n  return Number((subtotal + calculateTax(subtotal)).toFixed(2));\n}\n",
    );
    fs.writeFileSync(
      path.join(repo, "test", "invoice.test.mjs"),
      [
        "import assert from 'node:assert/strict';",
        "import fs from 'node:fs';",
        "const taxSrc = fs.readFileSync(new URL('../src/tax.ts', import.meta.url), 'utf8');",
        "const totalSrc = fs.readFileSync(new URL('../src/total.ts', import.meta.url), 'utf8');",
        "assert.ok(taxSrc.includes('0.08') || taxSrc.includes('0.1'), 'valid rate');",
        "assert.ok(totalSrc.includes('calculateTax'), 'uses calculateTax');",
        "assert.ok(!taxSrc.includes('BUGGY_BREAK'), 'no broken rate');",
      ].join("\n"),
    );

    // 1. One pack call: a search, two source files, and two env files (one of them secret).
    const t1 = performance.now();
    const packOut = await runPack({
      root: repo,
      query: "STRIPE_SECRET_KEY|calculateTax",
      files: ["src/tax.ts", "src/total.ts", ".env", ".env.example"],
      inline_only: true,
    });
    const hitCount = Number(/\((\d+) hits/.exec(packOut)?.[1] ?? "0");
    steps.push({
      tool: "pack",
      name: "pack + secret shield",
      passed:
        packOut.includes("calculateTax") &&
        packOut.includes("REDACTED SECRET FILE") &&
        !packOut.includes("sk_live_demo_redacted_123") &&
        packOut.includes("replace_me"),
      ms: Math.round(performance.now() - t1),
      did: "search + 2 source files + .env + .env.example, in 1 call",
      detail: `${hitCount} hits, 3 files, .env redacted (key never left disk)`,
    });

    // 2. A bad edit: the test fails, so the file must come back byte-for-byte.
    const t2 = performance.now();
    const taxPath = path.join(repo, "src", "tax.ts");
    const beforeHash = sha256File(taxPath);
    const failShip = await runShip({
      cwd: repo,
      edits: [
        {
          path: "src/tax.ts",
          search: "return Number((amount * 0.08).toFixed(2));",
          replace: "return BUGGY_BREAK; // broken edit",
        },
      ],
      verify: VERIFY,
    });
    const afterHash = sha256File(taxPath);
    steps.push({
      tool: "ship",
      name: "ship rollback on test failure",
      passed: failShip.status === "FAILED_AND_ROLLED_BACK" && beforeHash === afterHash,
      ms: Math.round(performance.now() - t2),
      did: `broken edit to src/tax.ts, verify: ${VERIFY}`,
      detail: `test failed, file restored byte-for-byte (sha256 ${afterHash.slice(0, 8)})`,
    });

    // 3. A good two-file edit: the same test passes, so both files are kept.
    const t3 = performance.now();
    const passShip = await runShip({
      cwd: repo,
      edits: [
        { path: "src/tax.ts", search: "0.08", replace: "0.1" },
        {
          path: "src/total.ts",
          search: "subtotal + calculateTax(subtotal)",
          replace: "subtotal + calculateTax(subtotal) /* updated */",
        },
      ],
      verify: VERIFY,
    });
    steps.push({
      tool: "ship",
      name: "ship verified 2-file edit",
      passed: passShip.status === "SHIPPED_AND_VERIFIED",
      ms: Math.round(performance.now() - t3),
      did: "good edit to src/tax.ts + src/total.ts, same verify",
      detail: "test passed, both files kept",
    });

    // 4. One batch script: outline every file, then try to break out of read-only.
    const t4 = performance.now();
    const batch = await runBatchDetailed({
      cwd: repo,
      code: `
        const tsFiles = ctx.files('**/*.ts');
        const symbols = tsFiles.flatMap((f) => ctx.outline(f).map((s) => f + ':' + s.name));
        let execBlocked = false;
        try { await ctx.exec('echo nope'); } catch (e) { execBlocked = String(e).includes('ERR_EXEC_DISABLED'); }
        let escapeBlocked = false;
        try { ctx.files.constructor('return process')(); } catch (e) { escapeBlocked = true; }
        return { files: tsFiles.length, symbols, execBlocked, escapeBlocked };
      `,
    });
    steps.push({
      tool: "batch",
      name: "batch read-only analysis",
      passed:
        batch.text.includes("BATCH OK") &&
        batch.text.includes('"execBlocked": true') &&
        batch.text.includes('"escapeBlocked": true') &&
        batch.text.includes("src/tax.ts:calculateTax"),
      ms: Math.round(performance.now() - t4),
      did: "1 script: outline all .ts files, try exec, try a sandbox escape",
      detail:
        batch.isolation === "permission"
          ? "2 files outlined, exec + escape refused (no-write process)"
          : "2 files outlined, exec + escape refused (separate process)",
    });

    // 5. The fences: outside the repo, and the two places inside it ship must never touch.
    const t5 = performance.now();
    const jailPack = await runPack({ root: repo, files: ["../outside.txt"], inline_only: true });
    const jailShip = await runShip({
      cwd: repo,
      writes: [{ path: ".git/hooks/pre-commit", content: "#!/bin/sh\necho owned\n" }],
    });
    const cfgShip = await runShip({
      cwd: repo,
      writes: [{ path: ".turnpack.json", content: "{}" }],
    });
    steps.push({
      tool: "fences",
      name: "workspace jail + protected paths",
      passed:
        jailPack.includes("ERR_PATH_OUTSIDE_WORKSPACE") &&
        !jailPack.includes("not part of the repo") &&
        jailShip.status === "ABORTED_BEFORE_WRITE" &&
        cfgShip.status === "ABORTED_BEFORE_WRITE" &&
        !fs.existsSync(path.join(repo, ".git", "hooks", "pre-commit")),
      ms: Math.round(performance.now() - t5),
      did: "read ../outside.txt, write .git/hooks/pre-commit + .turnpack.json",
      detail: "all three refused, nothing written",
    });
  } finally {
    await removeTempDir(sandbox);
  }

  const report: DemoReport = {
    ok: steps.every((s) => s.passed),
    steps,
    totalMs: Math.round(performance.now() - tStart),
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report;
  }

  const out: string[] = [
    "",
    `${bold("turnpack demo")}  ${dim("· a throwaway repo in your temp folder; nothing of yours is touched")}`,
    rule(80),
  ];
  for (const s of report.steps) {
    const mark = s.passed ? green("ok") : red("FAIL");
    const timing = `${s.ms} ms`.padStart(7);
    out.push(`  ${cyan(s.tool.padEnd(7))}${s.did}`);
    out.push(`  ${" ".repeat(7)}${dim("->")} ${s.detail.padEnd(DETAIL_WIDTH)}${dim(timing)}  ${mark}`);
  }
  out.push(rule(80));
  const passedCount = report.steps.filter((s) => s.passed).length;
  out.push(
    report.ok
      ? `  ${green(`${passedCount}/${report.steps.length} passed`)} in ${report.totalMs} ms.  Next: ${bold("npx turnpack init")}`
      : `  ${red(`${report.steps.length - passedCount} of ${report.steps.length} FAILED`)} — please open an issue with the output of: npx turnpack doctor`,
  );
  out.push("");
  process.stdout.write(`${out.join("\n")}\n`);
  return report;
}
