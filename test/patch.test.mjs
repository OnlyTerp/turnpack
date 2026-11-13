import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runShip } from "../dist/index.js";
import { applyHunks, parsePatch } from "../dist/tools/patch.js";
import { removeDir } from "./helpers.mjs";

const lines = (...parts) => parts.join("\n");

describe("patches for ship", () => {
  it("reads the apply_patch format: update, add, delete and move", () => {
    const files = parsePatch(
      lines(
        "*** Begin Patch",
        "*** Update File: src/tax.js",
        "*** Move to: src/pricing/tax.js",
        "@@ export function tax(n) {",
        "-  return n * RATE;",
        "+  return round(n * RATE);",
        "*** Add File: src/round.js",
        "+export const round = Math.round;",
        "+",
        "*** Delete File: src/old.js",
        "*** End Patch",
        "",
      ),
    );
    assert.deepEqual(
      files.map((f) => [f.kind, f.path, f.moveTo]),
      [
        ["update", "src/tax.js", "src/pricing/tax.js"],
        ["add", "src/round.js", undefined],
        ["delete", "src/old.js", undefined],
      ],
    );
    assert.deepEqual(files[0].hunks, [
      { anchors: ["export function tax(n) {"], before: ["  return n * RATE;"], after: ["  return round(n * RATE);"], atEnd: false },
    ]);
    assert.equal(files[1].content, "export const round = Math.round;\n\n");

    assert.throws(() => parsePatch("just some prose"), /no files found\. Use the apply_patch format/);
    assert.throws(() => parsePatch("*** Update File: a.js\n"), /"a\.js" is marked for update but has no changes/);
  });

  it("reads a unified diff, ignoring its line numbers", () => {
    const files = parsePatch(
      lines(
        "diff --git a/src/tax.js b/src/tax.js",
        "index 1111111..2222222 100644",
        "--- a/src/tax.js",
        "+++ b/src/tax.js",
        "@@ -90,3 +90,3 @@ export const RATE = 0.08;",
        " export function tax(n) {",
        "-  return n * RATE;",
        "+  return round(n * RATE);",
        " }",
        "\\ No newline at end of file",
        "diff --git a/src/new.js b/src/new.js",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/new.js",
        "@@ -0,0 +1,2 @@",
        "+export const A = 1;",
        "+export const B = 2;",
        "diff --git a/src/gone.js b/src/gone.js",
        "deleted file mode 100644",
        "--- a/src/gone.js",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-export const GONE = true;",
        "diff --git a/src/a.js b/src/b.js",
        "similarity index 100%",
        "rename from src/a.js",
        "rename to src/b.js",
      ),
    );
    assert.deepEqual(
      files.map((f) => [f.kind, f.path, f.moveTo, f.hunks.length]),
      [
        ["update", "src/tax.js", undefined, 1],
        ["add", "src/new.js", undefined, 0],
        ["delete", "src/gone.js", undefined, 0],
        ["update", "src/a.js", "src/b.js", 0],
      ],
    );
    assert.equal(files[1].content, "export const A = 1;\nexport const B = 2;\n");

    // The numbers said line 90; the context says where it really is.
    const out = applyHunks("export const RATE = 0.08;\n\nexport function tax(n) {\n  return n * RATE;\n}\n", files[0].hunks);
    assert.equal(out.text, "export const RATE = 0.08;\n\nexport function tax(n) {\n  return round(n * RATE);\n}\n");
  });

  it("places each hunk by its context, in order, and tolerates what a model gets slightly wrong", () => {
    const file = lines("class A {", "  run() {", "    return 1;", "  }", "}", "", "class B {", "  run() {", "    return 1;", "  }", "}", "");
    const [update] = parsePatch(
      lines(
        "*** Begin Patch",
        "*** Update File: x.js",
        "@@ class B {",
        "   run() {",
        "-    return 1;",
        "+    return 2;",
        "   }",
        "*** End Patch",
      ),
    );
    // The same three lines exist in class A; the anchor says class B.
    assert.equal(applyHunks(file, update.hunks).text, file.replace("class B {\n  run() {\n    return 1;", "class B {\n  run() {\n    return 2;"));

    // Two hunks with identical context are taken top to bottom.
    const [both] = parsePatch(lines("*** Update File: x.js", "@@", "-    return 1;", "+    return 10;", "@@", "-    return 1;", "+    return 20;"));
    assert.equal(applyHunks(file, both.hunks).text, file.replace("return 1;", "return 10;").replace("return 1;", "return 20;"));

    // Context written without its indentation, in a CRLF file with tabs: found, and re-indented.
    const tabbed = "function f() {\r\n\tif (x) {\r\n\t\treturn 1;\r\n\t}\r\n}\r\n";
    const [loose] = parsePatch(lines("*** Update File: x.js", "@@", " if (x) {", "-    return 1;", "+    log();", "+    return 2;", " }"));
    const fixed = applyHunks(tabbed, loose.hunks);
    assert.equal(fixed.text, "function f() {\r\n\tif (x) {\r\n\t\tlog();\r\n\t\treturn 2;\r\n\t}\r\n}\r\n");
    assert.deepEqual(fixed.notes, ["the hunk matched by ignoring indentation"]);

    // Lines that are only added go after the anchor, or at the end of the file.
    const [insert] = parsePatch(lines("*** Update File: x.js", "@@ class A {", "+  static id = 1;", "@@", "+// end", "*** End of File"));
    assert.equal(
      applyHunks("class A {\n}\n", insert.hunks).text,
      "class A {\n  static id = 1;\n}\n// end\n",
    );

    // Removing lines leaves no blank line behind.
    const [removal] = parsePatch(lines("*** Update File: x.js", "@@", " a();", "-b();", "-c();", " d();"));
    assert.equal(applyHunks("a();\nb();\nc();\nd();\n", removal.hunks).text, "a();\nd();\n");

    const [wrong] = parsePatch(lines("*** Update File: x.js", "@@", "   run() {", "-    return 3;", "+    return 4;", "   }"));
    const miss = applyHunks(file, wrong.hunks);
    assert.equal(miss.ok, false);
    assert.match(miss.message, /the hunk: its context and removed lines were not found\. The closest text is lines 2-4/);
    assert.match(miss.message, /search has: " {4}return 3;"/);
  });
});

describe("ship with a patch", () => {
  let repoDir;
  const sha = (rel) => crypto.createHash("sha256").update(fs.readFileSync(path.join(repoDir, rel))).digest("hex");
  const read = (rel) => fs.readFileSync(path.join(repoDir, rel), "utf8");

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "turnpack-patch-"));
    fs.mkdirSync(path.join(repoDir, "src"));
    fs.writeFileSync(path.join(repoDir, "src", "tax.js"), "export const RATE = 0.08;\n\nexport function calculateTax(n) {\n  return n * RATE;\n}\n");
    fs.writeFileSync(path.join(repoDir, "src", "invoice.js"), 'import { calculateTax } from "./tax.js";\n\nexport const total = (n) => n + calculateTax(n);\n');
    fs.writeFileSync(path.join(repoDir, "src", "legacy.js"), "export const OLD = true;\n");
    fs.writeFileSync(
      path.join(repoDir, "check.mjs"),
      'import { total } from "./src/invoice.js";\nimport fs from "node:fs";\nif (total(100) !== 108 || fs.existsSync("src/legacy.js") || !fs.existsSync("src/notes.md")) process.exit(1);\n',
    );
  });

  afterEach(() => removeDir(repoDir));

  const RENAME = lines(
    "*** Begin Patch",
    "*** Update File: src/tax.js",
    "@@",
    "-export function calculateTax(n) {",
    "+export function computeTax(n) {",
    "*** Update File: src/invoice.js",
    "@@",
    '-import { calculateTax } from "./tax.js";',
    '+import { computeTax } from "./tax.js";',
    "@@",
    "-export const total = (n) => n + calculateTax(n);",
    "+export const total = (n) => n + computeTax(n);",
    "*** Add File: src/notes.md",
    "+# Notes",
    "*** Delete File: src/legacy.js",
    "*** End Patch",
  );

  it("applies a multi-file patch, tests it, and keeps it only if the test passes", async () => {
    const before = ["src/tax.js", "src/invoice.js", "src/legacy.js"].map(sha);

    // The same patch with the call site left out: the test fails, and everything comes back.
    const broken = RENAME.replace(/^@@\n-export const total[\s\S]*?computeTax\(n\);\n/m, "");
    const failed = await runShip({ cwd: repoDir, patch: broken, verify: ["node check.mjs"] });
    assert.equal(failed.status, "FAILED_AND_ROLLED_BACK");
    assert.match(failed.summary, /Restored 4 file\(s\) to byte-exact pre-edit snapshots/);
    assert.deepEqual(["src/tax.js", "src/invoice.js", "src/legacy.js"].map(sha), before);
    assert.equal(fs.existsSync(path.join(repoDir, "src", "notes.md")), false);

    const shipped = await runShip({ cwd: repoDir, patch: RENAME, verify: ["node check.mjs"] });
    assert.equal(shipped.status, "SHIPPED_AND_VERIFIED");
    assert.match(shipped.summary, /4 file\(s\) changed \(src\/tax\.js, src\/invoice\.js, src\/notes\.md \(new\), src\/legacy\.js \(deleted\)\)/);
    assert.match(read("src/tax.js"), /export function computeTax/);
    assert.equal(read("src/notes.md"), "# Notes\n");
    assert.equal(fs.existsSync(path.join(repoDir, "src", "legacy.js")), false);
  });

  it("takes a unified diff, moves a file through a patch, and lists every hunk that does not fit", async () => {
    const diff = lines(
      "--- a/src/tax.js",
      "+++ b/src/rates.js",
      "@@ -1,1 +1,1 @@",
      "-export const RATE = 0.08;",
      "+export const RATE = 0.1;",
    );
    const moved = await runShip({
      cwd: repoDir,
      diff,
      edits: [{ path: "src/invoice.js", search: "./tax.js", replace: "./rates.js" }],
    });
    assert.equal(moved.status, "APPLIED_NO_VERIFY");
    assert.match(moved.summary, /src\/rates\.js \(moved from src\/tax\.js\), src\/invoice\.js/);
    assert.equal(fs.existsSync(path.join(repoDir, "src", "tax.js")), false);
    assert.match(read("src/rates.js"), /RATE = 0\.1;/);

    const stale = await runShip({
      cwd: repoDir,
      patch: lines(
        "*** Begin Patch",
        "*** Update File: src/rates.js",
        "@@",
        "-export const RATE = 0.08;",
        "+export const RATE = 0.2;",
        "*** Update File: src/missing.js",
        "@@",
        "-a",
        "+b",
        "*** Update File: .git/config",
        "@@",
        "-a",
        "+b",
        "*** End Patch",
      ),
    });
    assert.equal(stale.status, "ABORTED_BEFORE_WRITE");
    assert.match(stale.summary, /3 problems, nothing was written/);
    assert.match(stale.summary, /src\/rates\.js \(patch\): the hunk: its context and removed lines were not found\. The closest text is lines 1-1/);
    assert.match(stale.summary, /Patch target not found: "src\/missing\.js"/);
    assert.match(stale.summary, /"\.git\/config" is protected/);
    assert.match(read("src/rates.js"), /RATE = 0\.1;/);

    const garbage = await runShip({ cwd: repoDir, patch: "please rename the function" });
    assert.match(garbage.summary, /ABORTED_BEFORE_WRITE: patch: no files found/);
  });
});
