import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runBatch } from "../tools/batch.js";
import { runPack } from "../tools/pack.js";
import { runShip } from "../tools/ship.js";

export interface DemoStep {
  name: string;
  passed: boolean;
  ms: number;
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

export async function runDemo(options: { json?: boolean } = {}): Promise<DemoReport> {
  const tStart = performance.now();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "turnpack-demo-"));
  const steps: DemoStep[] = [];

  try {
    fs.mkdirSync(path.join(tempRoot, "src"), { recursive: true });
    fs.mkdirSync(path.join(tempRoot, "test"), { recursive: true });

    fs.writeFileSync(path.join(tempRoot, ".env"), "STRIPE_SECRET_KEY=sk_live_demo_redacted_123\n");
    fs.writeFileSync(
      path.join(tempRoot, ".env.example"),
      "STRIPE_SECRET_KEY=replace_me\n",
    );
    fs.writeFileSync(
      path.join(tempRoot, "src", "tax.ts"),
      "export function calculateTax(amount: number): number {\n  return Number((amount * 0.08).toFixed(2));\n}\n",
    );
    fs.writeFileSync(
      path.join(tempRoot, "src", "total.ts"),
      "import { calculateTax } from './tax.js';\nexport function invoiceTotal(subtotal: number): number {\n  return Number((subtotal + calculateTax(subtotal)).toFixed(2));\n}\n",
    );
    fs.writeFileSync(
      path.join(tempRoot, "test", "invoice.test.mjs"),
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

    // 1. Pack + Secret Shield
    const t1 = performance.now();
    const packOut = await runPack({
      root: tempRoot,
      query: "STRIPE_SECRET_KEY|calculateTax",
      files: ["src/tax.ts", "src/total.ts", ".env", ".env.example"],
      inline_only: true,
    });
    const ms1 = Math.round(performance.now() - t1);
    const packOk =
      packOut.includes("calculateTax") &&
      packOut.includes("REDACTED SECRET FILE") &&
      !packOut.includes("sk_live_demo_redacted_123") &&
      packOut.includes("replace_me");
    steps.push({
      name: "pack + secret shield",
      passed: packOk,
      ms: ms1,
      detail: "Bundled 2 source files + .env.example + regex search in 1 call; blocked .env secret",
    });

    // 2. Ship rollback on failing test
    const t2 = performance.now();
    const beforeHash = sha256File(path.join(tempRoot, "src", "tax.ts"));
    const failShip = await runShip({
      cwd: tempRoot,
      edits: [
        {
          path: "src/tax.ts",
          search: "return Number((amount * 0.08).toFixed(2));",
          replace: "return BUGGY_BREAK; // broken edit",
        },
      ],
      verify: "node test/invoice.test.mjs",
    });
    const afterHash = sha256File(path.join(tempRoot, "src", "tax.ts"));
    const ms2 = Math.round(performance.now() - t2);
    const rollbackOk =
      failShip.status === "FAILED_AND_ROLLED_BACK" && beforeHash === afterHash;
    steps.push({
      name: "ship rollback on test failure",
      passed: rollbackOk,
      ms: ms2,
      detail: "Caught failing test and restored exact pre-edit SHA-256 bytes",
    });

    // 3. Ship passing multi-file edit
    const t3 = performance.now();
    const passShip = await runShip({
      cwd: tempRoot,
      edits: [
        { path: "src/tax.ts", search: "0.08", replace: "0.1" },
        {
          path: "src/total.ts",
          search: "subtotal + calculateTax(subtotal)",
          replace: "subtotal + calculateTax(subtotal) /* updated */",
        },
      ],
      verify: "node test/invoice.test.mjs",
    });
    const ms3 = Math.round(performance.now() - t3);
    steps.push({
      name: "ship verified 2-file edit",
      passed: passShip.status === "SHIPPED_AND_VERIFIED",
      ms: ms3,
      detail: "Applied 2-file edit and passed node verification",
    });

    // 4. Read-only batch
    const t4 = performance.now();
    const batchOut = await runBatch({
      cwd: tempRoot,
      code: `
        const tsFiles = ctx.files('**/*.ts');
        let execBlocked = false;
        try { await ctx.exec('echo nope'); } catch (e) { execBlocked = String(e).includes('ERR_EXEC_DISABLED'); }
        return { files: tsFiles, outlines: tsFiles.map((f) => ctx.outline(f)), execBlocked };
      `,
    });
    const ms4 = Math.round(performance.now() - t4);
    const batchOk = batchOut.includes("BATCH OK") && batchOut.includes('"execBlocked": true');
    steps.push({
      name: "batch read-only analysis",
      passed: batchOk,
      ms: ms4,
      detail: "Outlined files in-process; confirmed shell exec disabled by default",
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  const report: DemoReport = {
    ok: steps.every((s) => s.passed),
    steps,
    totalMs: Math.round(performance.now() - tStart),
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write("\nturnpack live sandbox demo (isolated temp folder, 0 repo changes)\n");
    process.stdout.write("─────────────────────────────────────────────────────────────────\n");
    for (const s of report.steps) {
      const tag = s.passed ? "PASS" : "FAIL";
      process.stdout.write(`  [${tag}] ${s.name.padEnd(28)} ${String(s.ms).padStart(4)}ms  ${s.detail}\n`);
    }
    process.stdout.write("─────────────────────────────────────────────────────────────────\n");
    process.stdout.write(
      `  ${report.ok ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED"} in ${report.totalMs}ms. Next: npx turnpack init\n\n`,
    );
  }

  return report;
}
