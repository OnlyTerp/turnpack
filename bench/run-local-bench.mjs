#!/usr/bin/env node
// Local engine timings only: how long pack, batch and ship take on a generated workspace.
// No model is involved, so this says nothing about how much faster an agent finishes a task.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runBatch, runPack, runShip } from "../dist/index.js";

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Number((((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2).toFixed(1))
    : Number((sorted[mid] ?? 0).toFixed(1));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "turnpack-bench-"));
try {
  fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
  for (let i = 0; i < 40; i++) {
    fs.writeFileSync(
      path.join(tmp, "src", `mod${i}.ts`),
      `export function fn${i}(x: number): number {\n  return x + ${i};\n}\n`,
    );
  }
  fs.writeFileSync(path.join(tmp, ".env"), "LOCAL_BENCH_SECRET=redacted\n");
  fs.writeFileSync(path.join(tmp, "ok.mjs"), "process.exit(0);\n");

  const packTimes = [];
  const batchTimes = [];
  const shipTimes = [];

  for (let r = 0; r < 5; r++) {
    const t0 = performance.now();
    await runPack({
      root: tmp,
      query: "fn1|fn20",
      files: ["src/mod1.ts", "src/mod10.ts", "src/mod20.ts", "src/mod30.ts", ".env"],
      inline_only: true,
    });
    packTimes.push(performance.now() - t0);

    const t1 = performance.now();
    await runBatch({
      cwd: tmp,
      code: `return ctx.files('src/*.ts').map((f) => ({ f, syms: ctx.outline(f).length }));`,
    });
    batchTimes.push(performance.now() - t1);

    const t2 = performance.now();
    await runShip({
      cwd: tmp,
      edits: [
        { path: "src/mod1.ts", search: "x + 1", replace: "x + 1" },
        { path: "src/mod2.ts", search: "x + 2", replace: "x + 2" },
      ],
      verify: "node ok.mjs",
    });
    shipTimes.push(performance.now() - t2);
  }

  const summary = {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    fixtureFiles: 42,
    runsPerOp: 5,
    packMedianMs: median(packTimes),
    batchMedianMs: median(batchTimes),
    shipVerifyMedianMs: median(shipTimes),
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
