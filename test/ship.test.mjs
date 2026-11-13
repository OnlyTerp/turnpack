import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runShip } from "../dist/index.js";

function sha(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

describe("ship multi-file edit, verify, and preimage rollback", () => {
  let repoDir;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "turnpack-ship-"));
    fs.writeFileSync(path.join(repoDir, "a.js"), "export const A = 1;\n");
    fs.writeFileSync(path.join(repoDir, "b.js"), "export const B = 2;\n");
    fs.writeFileSync(
      path.join(repoDir, "check.mjs"),
      "import { A } from './a.js'; import { B } from './b.js'; if (A + B !== 3 && A + B !== 30) process.exit(1);\n",
    );
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it("aborts before writing if any edit anchor is missing", async () => {
    const aBefore = sha(path.join(repoDir, "a.js"));
    const res = await runShip({
      cwd: repoDir,
      edits: [
        { path: "a.js", search: "export const A = 1;", replace: "export const A = 10;" },
        { path: "b.js", search: "DOES_NOT_EXIST", replace: "export const B = 20;" },
      ],
      verify: "node check.mjs",
    });

    assert.equal(res.status, "ABORTED_BEFORE_WRITE");
    assert.equal(sha(path.join(repoDir, "a.js")), aBefore);
  });

  it("applies multi-file edits and passes verify -> SHIPPED_AND_VERIFIED", async () => {
    const res = await runShip({
      cwd: repoDir,
      edits: [
        { path: "a.js", search: "1", replace: "10" },
        { path: "b.js", search: "2", replace: "20" },
      ],
      verify: "node check.mjs",
    });

    assert.equal(res.status, "SHIPPED_AND_VERIFIED");
    assert.equal(res.verifyPassed, true);
    assert.deepEqual(res.filesModified, ["a.js", "b.js"]);
    assert.match(fs.readFileSync(path.join(repoDir, "a.js"), "utf8"), /10/);
  });

  it("rolls back all edits + new files to byte-exact snapshots when verify fails", async () => {
    const aBefore = sha(path.join(repoDir, "a.js"));
    const bBefore = sha(path.join(repoDir, "b.js"));

    const res = await runShip({
      cwd: repoDir,
      edits: [{ path: "a.js", search: "1", replace: "99" }],
      writes: [{ path: "new-temp.txt", content: "should be deleted on rollback" }],
      verify: "node check.mjs",
    });

    assert.equal(res.status, "FAILED_AND_ROLLED_BACK");
    assert.equal(sha(path.join(repoDir, "a.js")), aBefore);
    assert.equal(sha(path.join(repoDir, "b.js")), bBefore);
    assert.equal(fs.existsSync(path.join(repoDir, "new-temp.txt")), false);
  });

  it("supports rollback_on_verify_fail fallback alias and rollback_on_fail=false", async () => {
    const resKeep = await runShip({
      cwd: repoDir,
      edits: [{ path: "a.js", search: "1", replace: "99" }],
      verify: "node check.mjs",
      rollback_on_verify_fail: false,
    });
    assert.equal(resKeep.status, "FAILED_KEPT_ON_DISK");
    assert.match(fs.readFileSync(path.join(repoDir, "a.js"), "utf8"), /99/);
  });

  it("detects concurrent disk modification via expected_mtime_ms", async () => {
    const res = await runShip({
      cwd: repoDir,
      edits: [
        { path: "a.js", search: "1", replace: "10", expected_mtime_ms: 12345 },
      ],
    });
    assert.equal(res.status, "ABORTED_BEFORE_WRITE");
    assert.match(res.summary, /Precondition failed/);
  });

  it("reports FAILED_ROLLBACK_PARTIAL explicitly if snapshot restore fails", async () => {
    const res = await runShip(
      {
        cwd: repoDir,
        edits: [{ path: "a.js", search: "1", replace: "99" }],
        verify: "node check.mjs",
      },
      {
        restoreOps: {
          writeFile: () => {
            throw new Error("EACCES: simulated read-only disk");
          },
          unlink: () => {},
          readFile: (p) => fs.readFileSync(p),
        },
      },
    );
    assert.equal(res.status, "FAILED_ROLLBACK_PARTIAL");
    assert.equal(res.rollbackErrors.length, 1);
    assert.match(res.summary, /Rollback Errors/);
  });
});
