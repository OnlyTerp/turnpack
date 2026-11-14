# What Turnpack does when…

The questions people asked after the launch, answered one by one, with the edge cases and where each guarantee stops. The tests named here are in [`test/`](../test) and run on Windows, macOS and Linux.

## A check fails after some of the edits landed

**Everything the call changed is undone. Nothing is kept part-way.**

One `ship` call is one unit:

1. Every edit, patch, write, move and delete is checked in memory against the files as they are on disk. If anything does not fit, the call stops here with `ABORTED_BEFORE_WRITE` and every problem listed. Nothing was written, so there is nothing to undo.
2. All the files are written.
3. The verify commands run one after another, in the order given. The first one that fails stops the rest.
4. If one failed, every file the call touched goes back to its exact bytes, and the reply is `FAILED_AND_ROLLED_BACK`.

So a check never runs against half a change, and a failure never leaves half a change behind. If you want to keep part of a change regardless, ship that part as its own call first. `rollback_on_fail: false` is the opposite choice: keep everything, tested or not (`FAILED_KEPT_ON_DISK`).

The one exception is a file that something else changed while the check ran, for example you saved it in your editor. `ship` never overwrites that. It restores the rest, leaves that file as it is, and says so (`FAILED_ROLLBACK_PARTIAL`).

## The call created files, or moved or deleted some

**Undone too.** New files are removed, along with any folders created for them. Deleted files come back with their original permission bits. Moved files move back. The tests "rolls back all edits + new files" and "moves a file and edits it under its new name in one call, and undoes the move on failure" cover this.

## Which part of the change broke the check?

The failure reply says three things before the test output:

```text
FAILED_AND_ROLLED_BACK: verify "npm test" failed (exit code 1).

Restored 1 file(s) to byte-exact pre-edit snapshots. The workspace is unchanged; fix the edit and ship again.

Changed by this call and tested together: src/tax.js (line 3).

The failing output does not mention any file this call changed. It names src/invoice.js:1, a file this call did not change: often a caller or a test the change has not reached yet.
```

- **Which command failed, and which passed before it.** With `verify: ["tsc --noEmit", "npm test"]`, a test failure after a clean type check says `Passed before it: "tsc --noEmit".`
- **Which lines each file's change covers**, counted in the file as it is after the edit.
- **Where the failing output points.** When a compiler, test runner or stack trace names a file and line, the reply says whether that line is one the call wrote (`a line this call changed`), another line of a changed file (`not a line this call changed`), or a file the call did not touch at all, which usually means a caller or a test the change missed. Paths are recognised in the usual spellings: `file.js:12:5`, `file.ts(12,5)`, Python's `File "x.py", line 12`, and absolute paths and `file://` URLs inside the workspace.

When the call is rolled back, the lines the failure named are quoted as the check saw them:

```text
Changed by this call and tested together: src/tax.js (lines 1-2).

The failing output mentions src/tax.js:5 (not a line this call changed). It also names src/invoice.js:4, test/invoice.test.js:3, files this call did not change.
As the check saw that line, before the rollback:
  src/tax.js:5 | return Number((amount * TAX_RATE).toFixed(2));
```

Here the edit added a line at the top and renamed a constant, and missed a use of it further down. The rollback has put the old file back, so the line the error calls 5 is line 4 on disk again, and a line the edit wrote would not be on disk at all. Quoting it saves a read that would land on the wrong line. Files that hold secrets are never quoted.

Successful replies carry the same line ranges, so the model knows where its edit landed without reading the file again:

```text
SHIPPED_AND_VERIFIED in 283ms: 2 file(s) changed: src/tax.js (line 3), src/invoice.js (lines 1, 4).
```

## The process running the check is killed

**The next Turnpack process to look puts the files back.**

Before the first write, `ship` saves the original bytes of every file it is about to change to a rollback journal on disk, and flushes it. That is two flushes to disk, a few milliseconds, however many files the call changes. The record is deleted the moment the call's outcome is decided. If the process ends before that (`kill -9`, the app quits, Windows ends the process, a power cut), the record stays. Every Turnpack server on that machine, from any app, looks for such records when it starts and before each tool call. The first to find one puts the files back by the same rule as a normal rollback and leaves a note, and whichever server next works in that folder passes the note to the model at the top of its reply:

```text
[turnpack] An earlier ship call in /home/you/shop (started 2026-11-14T10:02:11Z) was cut off before its check finished: the turnpack process running it stopped. Its edits were never verified, so they were undone. Restored: src/tax.js. Removed (created by that call): src/rates.js.
```

- A file that was changed after the call (you edited it before Turnpack started again) is left as it is and named.
- Two cut-off calls that changed the same file are unwound newest first, so the file ends up as it was before both.
- The note is given once, and only for that folder (or one inside or around it). It is dropped if nobody opens the folder with Turnpack for 14 days.
- A call that asked to keep failed edits (`rollback_on_fail: false`) and was killed during its check keeps them, and the note says they are untested.
- Records live in `%LOCALAPPDATA%\turnpack\journal` on Windows and `$XDG_STATE_HOME/turnpack/journal` (or `~/.local/state/turnpack/journal`) elsewhere, readable only by you. `TURNPACK_STATE_DIR` moves them.
- SIGINT, SIGTERM and SIGHUP were already handled in the process itself: it stops the check and restores the files before exiting.
- If the app closes the connection while a check is running, the server now finishes that call, including its rollback, before it exits.

Where it stops:

- Until a Turnpack server starts or handles a call, the edits stay on disk.
- A process ID alone does not prove a process is dead: the system can hand a dead process's ID to a new one. When that happens Turnpack waits until the call's own time limit has passed (about two minutes with the default timeout) before undoing it. After a restart of the computer it does not wait.
- If the process dies in the instant it is writing a file back, that one file can be left half-written. The next start does not guess: it leaves the file and names it.
- A record from another machine (a shared home folder) is left alone.
- If a call runs longer than it possibly could (the computer slept through the check, for instance), another Turnpack process may take it for a dead one and undo it. The call then looks at the disk before it answers, and reports `FAILED_AND_ROLLED_BACK` with the reason if its files are gone, so nothing is reported as shipped that is not on disk.
- If the journal cannot be written (disk full, a read-only state folder, more than 64 MB of original bytes), `ship` warns once and works as before: a failing check is still undone, a killed process is not.
- Rollback restores files. It does not undo what the verify command itself did: a migrated database, generated files, a published package.

The tests under "a ship call cut off by its process ending" kill a real process mid-check and check the restore, the file changed since, the note, the order of two cut-off calls and the call another process took for dead.

## The plan changes after a read, or the read was of the wrong file

**Reading commits nothing, and every edit is checked against the file on disk before anything is written.** An edit planned from the wrong file, or from an old version of the right one, does not match, and the call stops with `ABORTED_BEFORE_WRITE`, the closest text in the real file and its line numbers. There is nothing to unwind, and the next attempt usually needs no new read. In the measured runs in [baselines.md](baselines.md), the median Turnpack run made two tool calls: one `pack` and one `ship`.

New: when a file changed on disk after the model last read it with `pack` (another tool wrote it, you edited it, another agent did), `ship` says so:

- If the edit's text still matches, the edit is applied, the check runs against the file as it is now, and the reply adds `Note: a.js changed on disk after you last read it with pack…`
- If it no longer matches, the abort adds `Read it again before writing the edit.`

This covers reads made with `pack` in the same session. It cannot see reads made with the app's own read tool.

## A step depends on what an earlier step found

Inside one `ship` call the order is fixed, so later operations can build on earlier ones:

1. moves, then the patch, then whole-file writes, then edits, then deletes;
2. several edits to one file apply in the order given, each to the result of the one before;
3. a file written in the call can be edited in the same call, and a moved file is edited under its new name.

Across calls, the step that cannot be folded away is the model deciding what to change from what it read. Turnpack removes the waits around that decision, not the decision: a search and the code around each hit come back in one `pack` (`context`), a fact about many files comes back from one `batch` script, and an edit and its test are one `ship`. The changed line ranges in every `ship` reply mean the model does not have to read the same files again after each edit to find out what they look like now.

## Replies and context size

Every model round trip re-reads the whole conversation, from cache where the app caches. Turnpack's gain comes from removing round trips, not from shrinking any one of them, so it also tries not to add bulk:

- `pack` reads stop at 200 lines by default and list the functions further down, so the next read can go straight to one. A function can be read alone (`"src/app.ts#handleLogin"`), or a file as an outline (`"src/app.ts#"`).
- Replies are capped per app (24,000 bytes inline by default for Claude Code). What does not fit goes to private files outside the repo that the model opens only if it needs them.
- `ship` returns about 1,500 bytes of output when the check passes, and the first 4 KB and last 16 KB when it fails, because test runners report failures at the end.
- The three tool schemas are 5,179 bytes and do not change during a session, so they sit in the cached part of the prompt.

## Which tests run

Exactly the commands in `verify`, from the workspace root, in order, stopping at the first failure. Turnpack does not choose a test scope for you. Two ways to keep it short:

- **`{files}`** in a command becomes the files the call changed, each quoted as one argument: `"npx vitest related {files} --run"`, `"npx jest --findRelatedTests {files}"`, `"npx eslint {files}"`. Deleted files are left out. A call that changes no file cannot use `{files}` and is refused before anything is written.
- **Fast check first, full suite after:** `["npx tsc --noEmit", "npm test"]`. A type error stops the call in seconds, before the slow suite starts.

With the verify allowlist on, the allowlist entry is the command as written, `{files}` included, so `"npx vitest related {files} --run"` can be approved once for every set of files. `{files}` has to stand on its own in the command. Inside quotes (`sh -c "eslint {files}"`) the quoting of each name stops working and a file name could carry a command of its own, so that is refused before anything is written. On Windows a file name containing `"`, `%`, `!` or `^` cannot be passed to `cmd.exe` safely, so a call that would need to is refused.

Each command has 60 seconds by default (`timeout_ms`, up to 300,000).
