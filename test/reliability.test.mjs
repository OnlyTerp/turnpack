import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import {
  changedLineRanges,
  expandFilesToken,
  formatRanges,
  journalDir,
  openJournal,
  pointsAt,
  recoverJournals,
  runShip,
  takeRecoveryNotes,
} from "../dist/index.js";
import { removeDir, startSession, wait } from "./helpers.mjs";

const DIST_INDEX = pathToFileURL(path.resolve(import.meta.dirname, "..", "dist", "index.js")).href;

function sha(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function journalEntries() {
  try {
    return fs.readdirSync(journalDir());
  } catch {
    return [];
  }
}

/**
 * Runs one ship call in a separate process and ends that process outright (SIGKILL, which is
 * TerminateProcess on Windows) while its verify command is running: what a crash, `kill -9` or
 * the app quitting does. No handler in the killed process gets to run.
 */
async function killMidVerify(repoDir, shipArgs) {
  const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "turnpack-crash-"));
  const script = path.join(scriptDir, "ship-child.mjs");
  fs.writeFileSync(
    script,
    `import { runShip } from ${JSON.stringify(DIST_INDEX)};\nawait runShip(JSON.parse(process.argv[2]));\n`,
  );
  // The verify command says it is running, then waits to be killed (or gives up after 30s).
  fs.writeFileSync(
    path.join(repoDir, "hold.mjs"),
    "import fs from 'node:fs'; fs.writeFileSync('hold.pid', String(process.pid)); setTimeout(() => {}, 30000);\n",
  );
  const child = spawn(process.execPath, [script, JSON.stringify({ cwd: repoDir, verify: ["node hold.mjs"], ...shipArgs })], {
    stdio: "ignore",
    windowsHide: true,
  });
  const pidFile = path.join(repoDir, "hold.pid");
  try {
    for (let waited = 0; !fs.existsSync(pidFile); waited += 50) {
      if (waited > 15000) throw new Error("the ship child never reached its verify command");
      if (child.exitCode !== null) throw new Error(`the ship child exited early with ${child.exitCode}`);
      await wait(50);
    }
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await exited;
    let holdPid = 0;
    for (let tries = 0; tries < 20 && !holdPid; tries++) {
      holdPid = Number(fs.readFileSync(pidFile, "utf8")) || 0;
      if (!holdPid) await wait(25);
    }
    try {
      process.kill(holdPid, "SIGKILL");
    } catch {
      // Already gone.
    }
    return child.pid;
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    fs.rmSync(pidFile, { force: true });
    fs.rmSync(path.join(repoDir, "hold.mjs"), { force: true });
    await removeDir(scriptDir);
  }
}

describe("which lines a change touched", () => {
  it("names replaced, inserted and removed lines in the new file's numbering", () => {
    assert.deepEqual(changedLineRanges("a\nb\nc\n", "a\nB\nc\n"), [[2, 2]]);
    assert.deepEqual(changedLineRanges("a\nb\nc\n", "a\nb\nx\ny\nc\n"), [[3, 4]]);
    // A removal has no line of its own: the line now in its place is named.
    assert.deepEqual(changedLineRanges("a\nb\nc\nd\n", "a\nd\n"), [[2, 2]]);
    assert.deepEqual(changedLineRanges("a\nb\n", "a\n"), [[1, 1]]);
    assert.deepEqual(changedLineRanges("", "x\ny\n"), [[1, 2]]);
    assert.deepEqual(changedLineRanges("same\n", "same\n"), []);
    // Line endings alone are not a change of lines.
    assert.deepEqual(changedLineRanges("a\r\nb\r\n", "a\r\nB\r\n"), [[2, 2]]);
  });

  it("keeps two separate edits apart in a long file", () => {
    const before = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`);
    const after = [...before];
    after[9] = "changed 10";
    after.splice(150, 0, "inserted", "inserted too");
    assert.deepEqual(changedLineRanges(`${before.join("\n")}\n`, `${after.join("\n")}\n`), [
      [10, 10],
      [151, 152],
    ]);
  });

  it("never misses a change in repetitive text with no unique lines", () => {
    const before = "}\n}\n}\n}\n";
    const after = "}\n}\nx\n}\n}\n";
    const ranges = changedLineRanges(before, after);
    assert.ok(ranges.some(([from, to]) => from <= 3 && to >= 3), JSON.stringify(ranges));
  });

  it("says it briefly", () => {
    assert.equal(formatRanges([[4, 4]]), "line 4");
    assert.equal(formatRanges([[4, 9], [30, 30]]), "lines 4-9, 30");
    assert.equal(
      formatRanges([[1, 1], [3, 3], [5, 5], [7, 7], [9, 9], [11, 11]]),
      "lines 1, 3, 5, 7 and 2 more places",
    );
    assert.equal(formatRanges([]), "");
  });
});

describe("pointing a failure at the change", () => {
  const root = process.platform === "win32" ? "C:\\work\\app" : "/work/app";
  const files = [
    { relPath: "src/a.js", ranges: [[10, 12]] },
    { relPath: "src/b.js", ranges: [[1, 1]] },
    { relPath: "old.js", gone: "deleted", ranges: [] },
  ];

  it("says whether the line a failure names is one the call wrote", () => {
    const text = pointsAt("Error at src/a.js:11:5\n    at src/b.js:40\n", files, root);
    assert.equal(
      text,
      "The failing output mentions src/a.js:11 (a line this call changed), src/b.js:40 (not a line this call changed).",
    );
  });

  it("reads the usual spellings of a location", () => {
    const abs = `${root}${path.sep}src${path.sep}a.js`;
    assert.match(pointsAt(`${abs}(11,3): error TS2322`, files, root), /src\/a\.js:11 \(a line this call changed\)/);
    assert.match(pointsAt(`  File "src/a.js", line 12, in f`, files, root), /src\/a\.js:12 \(a line this call changed\)/);
    assert.match(pointsAt("SyntaxError in ./src/b.js:1:1", files, root), /src\/b\.js:1 \(a line this call changed\)/);
  });

  it("is not fooled by a longer path that ends the same way", () => {
    assert.equal(
      pointsAt("lib/src/a.js:11 failed, other/old.js too", files, root),
      "The failing output does not mention any file this call changed.",
    );
  });

  it("names a file the call deleted", () => {
    assert.match(pointsAt("Cannot find module './old.js'", files, root), /old\.js \(deleted by this call\)/);
  });

  it("reads a file URL, where a space or a tilde in the folder name is written as %20 or %7E", () => {
    const spaced = process.platform === "win32" ? "C:\\my work\\app~1" : "/my work/app~1";
    const url = pathToFileURL(path.join(spaced, "src", "a.js")).href;
    assert.match(url, /%20/);
    assert.match(pointsAt(`${url}:11\n  two();\nSyntaxError: nope`, files, spaced), /src\/a\.js:11 \(a line this call changed\)/);
    assert.match(
      pointsAt(`    at f (${url}:40:3)`, files, spaced),
      /src\/a\.js:40 \(not a line this call changed\)/,
    );
  });

  it("does not take another folder whose path ends like the project's for the project", () => {
    if (process.platform === "win32") return;
    assert.equal(
      pointsAt(`/mnt/backup${root}/src/a.js:11 failed`, files, root),
      "The failing output does not mention any file this call changed.",
    );
  });

  it("quotes the named lines when it is given the file as the check saw it", () => {
    const withText = [{ relPath: "src/a.js", ranges: [[2, 2]], text: "one\n  two();\nthree\n" }];
    assert.equal(
      pointsAt("src/a.js:2:3 boom\nsrc/a.js:3 too", withText, root),
      "The failing output mentions src/a.js:2 (a line this call changed), src/a.js:3 (not a line this call changed).\n" +
        "As the check saw those lines, before the rollback:\n  src/a.js:2 | two();\n  src/a.js:3 | three",
    );
  });
});

describe("{files} in a verify command", () => {
  it("becomes the changed files, each one argument", () => {
    const quote = process.platform === "win32" ? (p) => `"${p}"` : (p) => `'${p}'`;
    assert.equal(
      expandFilesToken("eslint {files}", ["a.js", "sub dir/b.js"]),
      `eslint ${quote("a.js")} ${quote("sub dir/b.js")}`,
    );
    assert.equal(expandFilesToken("npm test", []), "npm test");
    // A name that starts with "-" must not be read as an option.
    assert.equal(expandFilesToken("prettier --check {files}", ["-x.js"]), `prettier --check ${quote("./-x.js")}`);
  });

  it("refuses when there is nothing to name", () => {
    assert.throws(() => expandFilesToken("eslint {files}", []), /uses \{files\}, but this call leaves no changed file/);
  });

  it("refuses {files} inside quotes, where a file name could carry a command of its own", () => {
    assert.throws(() => expandFilesToken('sh -c "eslint {files}"', ["a.js"]), /has \{files\} inside quotes/);
    // Quotes elsewhere in the command are fine.
    assert.match(expandFilesToken('node -e "" {files}', ["a.js"]), /a\.js/);
    if (process.platform !== "win32") {
      assert.throws(() => expandFilesToken("sh -c 'eslint {files}'", ["a.js"]), /has \{files\} inside quotes/);
      assert.equal(expandFilesToken("echo \\\" {files}", ["a.js"]), "echo \\\" 'a.js'");
    }
  });

  it("refuses a name the shell would rewrite", { skip: process.platform !== "win32" }, () => {
    assert.throws(() => expandFilesToken("eslint {files}", ["100%.js"]), /cannot be passed safely to cmd\.exe/);
  });
});

describe("ship replies say where each change landed and what a failure points at", () => {
  let repoDir;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "turnpack-rel-"));
    fs.writeFileSync(path.join(repoDir, "a.js"), "export const A = 1;\nexport const keep = true;\n");
    fs.mkdirSync(path.join(repoDir, "sub dir"));
    fs.writeFileSync(path.join(repoDir, "sub dir", "b.js"), "export const B = 2;\n");
    fs.writeFileSync(path.join(repoDir, "check.mjs"), "import { A } from './a.js'; if (A !== 10) process.exit(1);\n");
    fs.writeFileSync(path.join(repoDir, "args.mjs"), "console.log(JSON.stringify(process.argv.slice(2)));\n");
  });

  afterEach(() => removeDir(repoDir));

  it("lists the changed lines of each file and the size of a new one", async () => {
    const res = await runShip({
      cwd: repoDir,
      edits: [{ path: "a.js", search: "A = 1", replace: "A = 10" }],
      writes: [{ path: "notes/todo.md", content: "# Todo\n\n- one\n" }],
      verify: ["node check.mjs"],
    });
    assert.equal(res.status, "SHIPPED_AND_VERIFIED");
    // Files are listed in the order ship applies them: writes before edits.
    assert.match(res.summary, /2 file\(s\) changed: notes\/todo\.md \(new, 3 lines\), a\.js \(line 1\)\./);
  });

  it("says which check passed before the one that failed, and which edited line it names", async () => {
    // The failing check names line 1 of a.js, which this call rewrote.
    fs.writeFileSync(path.join(repoDir, "fail.mjs"), "console.error('a.js:1:14 - error: wrong value'); process.exit(1);\n");
    const aBefore = sha(path.join(repoDir, "a.js"));
    const res = await runShip({
      cwd: repoDir,
      edits: [{ path: "a.js", search: "A = 1", replace: "A = 10" }],
      verify: ["node check.mjs", "node fail.mjs"],
    });
    assert.equal(res.status, "FAILED_AND_ROLLED_BACK");
    assert.match(res.summary, /Passed before it: "node check\.mjs"\./);
    assert.match(res.summary, /Changed by this call and tested together: a\.js \(line 1\)\./);
    assert.match(res.summary, /The failing output mentions a\.js:1 \(a line this call changed\)\./);
    assert.equal(sha(path.join(repoDir, "a.js")), aBefore);
  });

  it("points a real syntax error at the line the edit broke", async () => {
    const res = await runShip({
      cwd: repoDir,
      edits: [{ path: "a.js", search: "export const keep = true;", replace: "export const keep = ;" }],
      verify: ["node check.mjs"],
    });
    assert.equal(res.status, "FAILED_AND_ROLLED_BACK");
    assert.match(res.summary, /The failing output mentions a\.js:2 \(a line this call changed\)/);
    // The broken line is gone from disk after the rollback, so the reply quotes it.
    assert.match(res.summary, /As the check saw that line, before the rollback:\n {2}a\.js:2 \| export const keep = ;/);
  });

  it("quotes a named line by its number in the edited file, not the restored one", async () => {
    // The edit adds two lines at the top, so the unchanged line the check names moved from 2 to 4.
    fs.writeFileSync(path.join(repoDir, "fail.mjs"), "console.error('a.js:4:1 - error: no'); process.exit(1);\n");
    const res = await runShip({
      cwd: repoDir,
      edits: [{ path: "a.js", search: "export const A = 1;", replace: "// one\n// two\nexport const A = 1;" }],
      verify: ["node fail.mjs"],
    });
    assert.equal(res.status, "FAILED_AND_ROLLED_BACK");
    assert.match(res.summary, /a\.js:4 \(not a line this call changed\)/);
    assert.match(res.summary, /a\.js:4 \| export const keep = true;/);
    assert.equal(fs.readFileSync(path.join(repoDir, "a.js"), "utf8"), "export const A = 1;\nexport const keep = true;\n");

    // A call that keeps its files has them on disk to read, so nothing is quoted.
    const kept = await runShip({
      cwd: repoDir,
      edits: [{ path: "a.js", search: "export const A = 1;", replace: "// one\n// two\nexport const A = 1;" }],
      verify: ["node fail.mjs"],
      rollback_on_fail: false,
    });
    assert.equal(kept.status, "FAILED_KEPT_ON_DISK");
    assert.doesNotMatch(kept.summary, /As the check saw/);
  });

  it("names the unchanged file a failure points at, such as a caller the edit missed", async () => {
    const res = await runShip({
      cwd: repoDir,
      edits: [{ path: "a.js", search: "export const A = 1;", replace: "export const AA = 1;" }],
      verify: ["node check.mjs"],
    });
    assert.equal(res.status, "FAILED_AND_ROLLED_BACK");
    // The error names a.js as the module that lacks the export, and check.mjs as where it failed.
    assert.match(res.summary, /It also names check\.mjs:1, a file this call did not change\./);
  });

  it("points at the right lines when the project folder has a space or a tilde in its name", async () => {
    // Node names a failing ES module by URL, with the space as %20 and the tilde as %7E.
    const spaced = fs.mkdtempSync(path.join(os.tmpdir(), "turnpack rel~1 "));
    try {
      fs.writeFileSync(path.join(spaced, "a.js"), "export const A = 1;\nexport const keep = true;\n");
      fs.writeFileSync(path.join(spaced, "check.mjs"), "import { A } from './a.js'; if (A !== 10) process.exit(1);\n");
      const broken = await runShip({
        cwd: spaced,
        edits: [{ path: "a.js", search: "export const keep = true;", replace: "export const keep = ;" }],
        verify: ["node check.mjs"],
      });
      assert.equal(broken.status, "FAILED_AND_ROLLED_BACK");
      assert.match(broken.summary, /The failing output mentions a\.js:2 \(a line this call changed\)/);
      assert.match(broken.summary, / {2}a\.js:2 \| export const keep = ;/);

      const renamed = await runShip({
        cwd: spaced,
        edits: [{ path: "a.js", search: "export const A = 1;", replace: "export const AA = 1;" }],
        verify: ["node check.mjs"],
      });
      assert.match(renamed.summary, /It also names check\.mjs:1, a file this call did not change\./);
    } finally {
      await removeDir(spaced);
    }
  });

  it("passes the changed files to a verify command that asks for {files}", async () => {
    const res = await runShip({
      cwd: repoDir,
      edits: [
        { path: "a.js", search: "A = 1", replace: "A = 10" },
        { path: "sub dir/b.js", search: "B = 2", replace: "B = 20" },
      ],
      verify: ["node args.mjs {files}"],
    });
    assert.equal(res.status, "SHIPPED_AND_VERIFIED");
    assert.match(res.summary, /\["a\.js","sub dir\/b\.js"\]/);

    // An allowlist entry approves the command as written, {files} included.
    fs.writeFileSync(
      path.join(repoDir, ".turnpack.json"),
      JSON.stringify({ enforceVerifyAllowlist: true, allowedVerify: ["node args.mjs {files}"] }),
    );
    const allowed = await runShip({
      cwd: repoDir,
      edits: [{ path: "a.js", search: "A = 10", replace: "A = 11" }],
      verify: ["node args.mjs {files}"],
    });
    assert.equal(allowed.status, "SHIPPED_AND_VERIFIED", allowed.summary);
    assert.match(allowed.summary, /\["a\.js"\]/);

    const none = await runShip({ cwd: repoDir, verify: ["node args.mjs {files}"] });
    assert.equal(none.status, "ABORTED_BEFORE_WRITE");
    assert.match(none.summary, /no changed file to name/);
  });
});

describe("a ship call cut off by its process ending", () => {
  let repoDir;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "turnpack-crash-repo-"));
    fs.writeFileSync(path.join(repoDir, "a.js"), "export const A = 1;\n");
    fs.writeFileSync(path.join(repoDir, "b.js"), "export const B = 2;\n");
    fs.writeFileSync(path.join(repoDir, "c.js"), "export const C = 3;\n");
  });

  afterEach(() => removeDir(repoDir));

  const shipArgs = {
    edits: [
      { path: "a.js", search: "A = 1", replace: "A = 10" },
      { path: "c.js", search: "C = 3", replace: "C = 30" },
    ],
    writes: [{ path: "made/by/ship.txt", content: "new\n" }],
    deletes: ["b.js"],
  };

  it("is undone by the next turnpack process, leaving alone a file changed since", async () => {
    const before = { a: sha(path.join(repoDir, "a.js")), b: sha(path.join(repoDir, "b.js")) };
    await killMidVerify(repoDir, shipArgs);

    // The killed process left its edits on disk, unverified.
    assert.match(fs.readFileSync(path.join(repoDir, "a.js"), "utf8"), /A = 10/);
    assert.equal(fs.existsSync(path.join(repoDir, "b.js")), false);
    // Someone edits c.js before turnpack starts again. That edit must survive.
    fs.writeFileSync(path.join(repoDir, "c.js"), "export const C = 300;\n");

    const notes = recoverJournals();
    assert.equal(notes.length, 1);
    assert.equal(notes[0].root, fs.realpathSync(repoDir));
    assert.match(notes[0].text, /was cut off before its check finished/);
    assert.match(notes[0].text, /Restored: (?=.*a\.js)(?=.*b\.js)/);
    assert.match(notes[0].text, /Removed \(created by that call\): made\/by\/ship\.txt/);
    assert.match(notes[0].text, /c\.js \(changed after that call, so it was left as it is\)/);

    assert.equal(sha(path.join(repoDir, "a.js")), before.a);
    assert.equal(sha(path.join(repoDir, "b.js")), before.b);
    assert.equal(fs.readFileSync(path.join(repoDir, "c.js"), "utf8"), "export const C = 300;\n");
    assert.equal(fs.existsSync(path.join(repoDir, "made")), false);
    assert.deepEqual(journalEntries(), []);
    assert.deepEqual(recoverJournals(), []);
  });

  it("keeps the edits of a call that asked to keep them when its check fails", async () => {
    await killMidVerify(repoDir, { ...shipArgs, rollback_on_fail: false });
    const notes = recoverJournals();
    assert.equal(notes.length, 1);
    assert.match(notes[0].text, /rollback_on_fail: false\), so they were left on disk, untested/);
    assert.match(fs.readFileSync(path.join(repoDir, "a.js"), "utf8"), /A = 10/);
    assert.equal(fs.existsSync(path.join(repoDir, "made", "by", "ship.txt")), true);
  });

  it("unwinds two cut-off calls on the same file newest first", async () => {
    const original = sha(path.join(repoDir, "a.js"));
    await killMidVerify(repoDir, { edits: [{ path: "a.js", search: "A = 1", replace: "A = 10" }] });
    await killMidVerify(repoDir, { edits: [{ path: "a.js", search: "A = 10", replace: "A = 100" }] });
    assert.match(fs.readFileSync(path.join(repoDir, "a.js"), "utf8"), /A = 100/);
    const notes = recoverJournals();
    assert.equal(notes.length, 2);
    for (const note of notes) assert.match(note.text, /Restored: a\.js\./);
    assert.equal(sha(path.join(repoDir, "a.js")), original);
    assert.equal(takeRecoveryNotes(repoDir).length, 2);
  });

  it("passes the note on from whichever process did the undoing, to that folder only", async () => {
    await killMidVerify(repoDir, shipArgs);
    // Another app's turnpack server, working somewhere else, is the first to look.
    assert.equal(recoverJournals().length, 1);
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "turnpack-elsewhere-"));
    fs.writeFileSync(path.join(elsewhere, "x.js"), "export const X = 1;\n");
    const other = startSession({ cwd: elsewhere });
    try {
      await other.initialize();
      assert.doesNotMatch((await other.call("pack", { files: ["x.js"] })).text, /\[turnpack\]/);
    } finally {
      await other.close();
      await removeDir(elsewhere);
    }
    const session = startSession({ cwd: repoDir });
    try {
      await session.initialize();
      const first = await session.call("pack", { files: ["a.js"] });
      assert.match(first.text, /^\[turnpack\] An earlier ship call in .* was cut off before its check finished/);
      const second = await session.call("pack", { files: ["a.js"] });
      assert.doesNotMatch(second.text, /\[turnpack\]/);
    } finally {
      await session.close();
    }
  });

  it("tells the model in its next reply about that folder", async () => {
    await killMidVerify(repoDir, shipArgs);
    const session = startSession({ cwd: repoDir });
    try {
      await session.initialize();
      const first = await session.call("pack", { files: ["a.js"] });
      assert.match(first.text, /^\[turnpack\] An earlier ship call in .* was cut off before its check finished/);
      assert.match(first.text, /export const A = 1;/);
      const second = await session.call("pack", { files: ["a.js"] });
      assert.doesNotMatch(second.text, /\[turnpack\]/);
    } finally {
      await session.close();
    }
  });

  it("leaves no record behind once a call is decided, and never undoes a verified one", async () => {
    const shipped = await runShip({ cwd: repoDir, ...shipArgs, verify: ["node -e \"\""] });
    assert.equal(shipped.status, "SHIPPED_AND_VERIFIED");
    const failed = await runShip({
      cwd: repoDir,
      edits: [{ path: "a.js", search: "A = 10", replace: "A = 11" }],
      verify: ["node -e \"process.exit(1)\""],
    });
    assert.equal(failed.status, "FAILED_AND_ROLLED_BACK");
    assert.deepEqual(journalEntries(), []);
    assert.deepEqual(recoverJournals(), []);
    assert.match(fs.readFileSync(path.join(repoDir, "a.js"), "utf8"), /A = 10;/);
  });

  it("reports a call as undone when another process claimed its record first", () => {
    const journal = openJournal({
      root: fs.realpathSync(repoDir),
      files: [],
      dirs: [],
      deadline: Date.now() + 60000,
      keepOnFail: false,
    });
    const [name] = journalEntries();
    // What a recovering process does first: rename the record to claim it.
    fs.renameSync(path.join(journalDir(), name), path.join(journalDir(), `${name}.undo-1`));
    assert.equal(journal.close(), false);
    fs.rmSync(path.join(journalDir(), `${name}.undo-1`), { recursive: true, force: true });
  });

  it("reports what is on disk when another process took a running call for a dead one", async () => {
    // The check itself plays the other process: it claims the record the way a recovery pass
    // does and, when asked, puts a.js back.
    fs.writeFileSync(
      path.join(repoDir, "claim.mjs"),
      [
        "import fs from 'node:fs'; import path from 'node:path';",
        "const dir = path.join(process.env.TURNPACK_STATE_DIR, 'journal');",
        "for (const name of fs.readdirSync(dir)) {",
        "  if (/^[0-9a-z]+-\\d+-[0-9a-f]+$/.test(name)) fs.renameSync(path.join(dir, name), path.join(dir, name + '.undo-1'));",
        "}",
        "if (process.argv[2] === 'undo') fs.writeFileSync('a.js', 'export const A = 1;\\n');",
        "",
      ].join("\n"),
    );
    const dropClaims = () => {
      for (const name of journalEntries()) fs.rmSync(path.join(journalDir(), name), { recursive: true, force: true });
    };
    try {
      const undone = await runShip({
        cwd: repoDir,
        edits: [{ path: "a.js", search: "A = 1", replace: "A = 10" }],
        verify: ["node claim.mjs undo"],
      });
      assert.equal(undone.status, "FAILED_AND_ROLLED_BACK");
      assert.match(undone.summary, /another turnpack process took it for one whose process had stopped/);
      dropClaims();

      // Claimed but not undone (a call that keeps its files): the edit is on disk, so it shipped.
      const kept = await runShip({
        cwd: repoDir,
        edits: [{ path: "a.js", search: "A = 1", replace: "A = 10" }],
        verify: ["node claim.mjs"],
      });
      assert.equal(kept.status, "SHIPPED_AND_VERIFIED", kept.summary);
      assert.match(fs.readFileSync(path.join(repoDir, "a.js"), "utf8"), /A = 10/);
    } finally {
      dropClaims();
    }
  });

  it("still ships when the journal cannot be written", async () => {
    const saved = process.env.TURNPACK_STATE_DIR;
    const blocker = path.join(repoDir, "not-a-dir");
    fs.writeFileSync(blocker, "");
    process.env.TURNPACK_STATE_DIR = blocker;
    try {
      const res = await runShip({
        cwd: repoDir,
        edits: [{ path: "a.js", search: "A = 1", replace: "A = 10" }],
        verify: ["node -e \"\""],
      });
      assert.equal(res.status, "SHIPPED_AND_VERIFIED");
    } finally {
      process.env.TURNPACK_STATE_DIR = saved;
    }
  });
});

describe("an edit to a file that changed after the model read it", () => {
  let repoDir;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "turnpack-stale-"));
    fs.writeFileSync(path.join(repoDir, "a.js"), "export const A = 1;\nexport const Z = 0;\n");
  });

  afterEach(() => removeDir(repoDir));

  it("is applied when its text still matches, with a note saying the file had changed", async () => {
    const session = startSession({ cwd: repoDir });
    try {
      await session.initialize();
      await session.call("pack", { files: ["a.js"] });
      // Another tool, an editor or another agent changes the file after the read.
      fs.writeFileSync(path.join(repoDir, "a.js"), "export const A = 1;\nexport const Z = 99;\n");
      const res = await session.call("ship", {
        edits: [{ path: "a.js", search: "A = 1", replace: "A = 10" }],
        verify: ["node -e \"\""],
      });
      assert.equal(res.isError, false, res.text);
      assert.match(res.text, /a\.js changed on disk after you last read it with pack/);
      assert.equal(fs.readFileSync(path.join(repoDir, "a.js"), "utf8"), "export const A = 10;\nexport const Z = 99;\n");

      // What ship wrote is what the model now knows, so the next edit carries no note.
      const again = await session.call("ship", {
        edits: [{ path: "a.js", search: "A = 10", replace: "A = 11" }],
        verify: ["node -e \"\""],
      });
      assert.doesNotMatch(again.text, /changed on disk/);

      // When the change took away the edit's text, the abort says to read the file again.
      fs.writeFileSync(path.join(repoDir, "a.js"), "export const A = 2;\n");
      const gone = await session.call("ship", {
        edits: [{ path: "a.js", search: "A = 11", replace: "A = 12" }],
        verify: ["node -e \"\""],
      });
      assert.match(gone.text, /^ABORTED_BEFORE_WRITE/);
      assert.match(gone.text, /a\.js changed on disk after you last read it with pack\. Read it again/);

      // Two files changed since they were read; only the one whose edit no longer fits is named.
      fs.writeFileSync(path.join(repoDir, "b.js"), "export const B = 1;\n");
      await session.call("pack", { files: ["a.js", "b.js"] });
      fs.writeFileSync(path.join(repoDir, "a.js"), "export const A = 2;\n// more\n");
      fs.writeFileSync(path.join(repoDir, "b.js"), "export const B = 7;\n");
      const mixed = await session.call("ship", {
        edits: [
          { path: "a.js", search: "A = 2", replace: "A = 3" },
          { path: "b.js", search: "B = 1", replace: "B = 2" },
        ],
        verify: ["node -e \"\""],
      });
      assert.match(mixed.text, /^ABORTED_BEFORE_WRITE/);
      assert.match(mixed.text, /\n\nb\.js changed on disk after you last read it with pack\. Read it again/);
    } finally {
      await session.close();
    }
  });
});
