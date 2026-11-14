import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isInsideDir, isProtectedPath, resolveSafePath } from "./security.js";

/**
 * A ship call's rollback, written to disk before the first file changes.
 *
 * ship keeps its snapshots in memory and puts them back when verify fails. That covers every
 * outcome the process lives to see. It does not cover the process being ended outright while
 * the tests run: the app quitting, `kill -9`, Windows ending the process, a power cut. The
 * files would then stay half-shipped and never verified. So ship also saves each file's
 * original bytes here, and marks the record settled once the call's outcome is decided.
 *
 * A record that is not settled, whose process is gone (or has run past the longest the call
 * could take), belongs to a call that never finished. The next turnpack process to look puts
 * those files back by the same rule as a normal rollback: a file is restored only if it still
 * holds what ship wrote, so a change made since then is never overwritten. What it did is left
 * as a note on disk, so whichever turnpack server next works in that folder can tell the model.
 *
 * Folder names: `<id>.new` while being written (the workspace is not touched yet), `<id>`
 * while the call runs, `<id>.undo-<pid>` once a process has claimed it to undo it. A record
 * holding a `settled` file is finished with, whatever its name, and is only deleted.
 *
 * A record is two files, so a call costs two flushes however many files it changes:
 * `originals.bin`, every original laid end to end, and `manifest.json`, which says where each
 * one starts.
 */

export interface JournalFile {
  relPath: string;
  absPath: string;
  existed: boolean;
  /** The file's bytes before the call; empty when it did not exist. */
  bytes: Buffer;
  /** SHA-256 of `bytes`, or "" when the file did not exist. */
  sha256: string;
  mode: number | undefined;
  /** SHA-256 of what the call writes there, or null when the call removes the file. */
  shippedSha256: string | null;
}

export interface JournalInput {
  root: string;
  files: JournalFile[];
  /** Directories the call creates, so an undo can remove them again if they are empty. */
  dirs: string[];
  /** After this time (ms since the epoch) the call cannot still be running legitimately. */
  deadline: number;
  /** The call asked to keep its files when the check fails (rollback_on_fail: false). */
  keepOnFail: boolean;
}

export interface Journal {
  /** Records that every file is written and the check is running. */
  markVerifying(): void;
  /**
   * Marks the record settled: the call kept its files, or put them back itself. False when
   * another process claimed the record first, because this one looked stopped; that process
   * has put the files back, unless the call was one that keeps them.
   */
  close(): boolean;
}

export interface RecoveryNote {
  /** Workspace of the call that was undone. */
  root: string;
  text: string;
}

interface ManifestEntry {
  rel: string;
  abs: string;
  existed: boolean;
  sha256: string;
  shipped: string | null;
  mode: number | null;
  /** Where the original bytes sit in `originals.bin`. */
  offset: number;
  length: number;
}

interface Manifest {
  version: 1;
  pid: number;
  host: string;
  root: string;
  startedAt: number;
  deadline: number;
  keepOnFail: boolean;
  stage: "writing" | "verifying";
  dirs: string[];
  files: ManifestEntry[];
}

const MANIFEST = "manifest.json";
const ORIGINALS = "originals.bin";
const SETTLED = "settled";
/** Above this the bytes are not copied to disk; the in-memory rollback still applies. */
const MAX_JOURNAL_BYTES = 64 * 1024 * 1024;
const NAME = /^([0-9a-z]+)-(\d+)-([0-9a-f]+)(?:\.(new)|\.undo-(\d+))?$/;
/** A record still being written after this long was abandoned by a process that died. */
const STALE_STAGING_MS = 10 * 60 * 1000;
/** A note nobody came back for: the folder was not opened with turnpack again. */
const NOTE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** Slack when comparing a start time with the time the computer booted. */
const BOOT_SLACK_MS = 10 * 1000;

/** Records this process has open, which a recovery pass in the same process must leave alone. */
const openHere = new Set<string>();

function stateDir(): string {
  const override = process.env.TURNPACK_STATE_DIR;
  if (override) return path.resolve(override);
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(local, "turnpack");
  }
  const state = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(state, "turnpack");
}

/** Where records are kept: under `TURNPACK_STATE_DIR`, else a per-user state folder. */
export function journalDir(): string {
  return path.join(stateDir(), "journal");
}

function notesDir(): string {
  return path.join(stateDir(), "notes");
}

function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Written and flushed, so the record survives a power cut, not just a killed process. */
function writeDurable(file: string, data: Buffer | string | Buffer[]): void {
  const fd = fs.openSync(file, "w", 0o600);
  try {
    if (Array.isArray(data)) for (const part of data) fs.writeFileSync(fd, part);
    else fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function syncDir(dir: string): void {
  if (process.platform === "win32") return;
  try {
    const fd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Not every file system lets a directory be flushed.
  }
}

/** A rename, retried briefly: on Windows a virus scanner holding a new file blocks it for a moment. */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 6 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw err;
      pause(25 * attempt);
    }
  }
}

function removeQuietly(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Left for the next pass.
  }
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Whether the process that wrote a record can no longer be running the call. A process ID alone
 * does not say: the system hands a dead process's ID to a new one. So a call is also given up
 * once it has run past its own time limit, and at once when the computer has restarted since.
 */
function ownerGone(manifest: Manifest): boolean {
  if (!isAlive(manifest.pid)) return true;
  if (Date.now() >= manifest.deadline) return true;
  const bootedAt = Date.now() - os.uptime() * 1000;
  return bootedAt > manifest.startedAt + BOOT_SLACK_MS;
}

export function openJournal(input: JournalInput): Journal {
  const total = input.files.reduce((sum, file) => sum + file.bytes.length, 0);
  if (total > MAX_JOURNAL_BYTES) {
    throw new Error(`the files come to ${total} bytes, more than the ${MAX_JOURNAL_BYTES}-byte journal limit`);
  }
  const base = journalDir();
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const id = `${Date.now().toString(36)}-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
  const staging = path.join(base, `${id}.new`);
  const live = path.join(base, id);
  let offset = 0;
  const manifest: Manifest = {
    version: 1,
    pid: process.pid,
    host: os.hostname(),
    root: input.root,
    startedAt: Date.now(),
    deadline: input.deadline,
    keepOnFail: input.keepOnFail,
    stage: "writing",
    dirs: input.dirs,
    files: input.files.map((file) => {
      const length = file.existed ? file.bytes.length : 0;
      const entry: ManifestEntry = {
        rel: file.relPath,
        abs: file.absPath,
        existed: file.existed,
        sha256: file.sha256,
        shipped: file.shippedSha256,
        mode: file.mode ?? null,
        offset,
        length,
      };
      offset += length;
      return entry;
    }),
  };

  fs.mkdirSync(staging, { mode: 0o700 });
  try {
    if (offset > 0) {
      writeDurable(
        path.join(staging, ORIGINALS),
        input.files.filter((file) => file.existed).map((file) => file.bytes),
      );
    }
    writeDurable(path.join(staging, MANIFEST), JSON.stringify(manifest));
    renameWithRetry(staging, live);
    syncDir(base);
  } catch (err) {
    removeQuietly(staging);
    throw err;
  }
  openHere.add(id);

  return {
    markVerifying() {
      manifest.stage = "verifying";
      const next = path.join(live, `${MANIFEST}.next`);
      try {
        writeDurable(next, JSON.stringify(manifest));
        renameWithRetry(next, path.join(live, MANIFEST));
      } catch {
        // The record still says "writing". That only matters for a call that keeps failed
        // edits, and then the worst case is that an undo puts its files back.
      }
    },
    close() {
      openHere.delete(id);
      try {
        // The settled marker is the decision. The folder is only tidied up after it.
        writeDurable(path.join(live, SETTLED), "");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
        // Cannot mark it (disk full, permissions). Move it out of the way or remove it, so it
        // is never undone later; a name the recovery pass does not recognise is ignored.
        try {
          fs.renameSync(live, `${live}.kept`);
        } catch {
          removeQuietly(live);
        }
        if (fs.existsSync(live)) {
          process.stderr.write(`turnpack: could not settle the rollback record ${live}; delete it by hand\n`);
        }
        return true;
      }
      removeQuietly(live);
      return true;
    },
  };
}

function readManifest(dir: string): Manifest | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), "utf8")) as Manifest;
    if (parsed?.version !== 1 || !Array.isArray(parsed.files) || typeof parsed.root !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

function readOriginal(dir: string, entry: ManifestEntry): Buffer {
  const bytes = Buffer.alloc(entry.length);
  if (entry.length === 0) return bytes;
  const fd = fs.openSync(path.join(dir, ORIGINALS), "r");
  try {
    let got = 0;
    while (got < entry.length) {
      const read = fs.readSync(fd, bytes, got, entry.length - got, entry.offset + got);
      if (read === 0) break;
      got += read;
    }
    return bytes.subarray(0, got);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * True when the path in a record is still where ship would write: inside the workspace, not
 * protected, and not reached through a link put there since. The record is data on disk, so
 * each path is checked as carefully as a tool argument.
 */
function stillWritable(root: string, abs: string): boolean {
  if (!isInsideDir(root, abs) || isProtectedPath(abs)) return false;
  try {
    const resolved = resolveSafePath(root, abs).absPath;
    return process.platform === "win32" ? resolved.toLowerCase() === abs.toLowerCase() : resolved === abs;
  } catch {
    return false;
  }
}

function list(items: string[]): string {
  return items.join(", ");
}

/** Puts back the files of one claimed record and says what was done. */
function undo(manifest: Manifest, dir: string): RecoveryNote {
  const started = new Date(manifest.startedAt).toISOString().replace(/\.\d+Z$/, "Z");
  const opening = `An earlier ship call in ${manifest.root} (started ${started}) was cut off before its check finished: the turnpack process running it stopped.`;
  if (manifest.stage === "verifying" && manifest.keepOnFail) {
    return {
      root: manifest.root,
      text: `${opening} That call asked to keep its edits if the check failed (rollback_on_fail: false), so they were left on disk, untested.`,
    };
  }

  const restored: string[] = [];
  const removed: string[] = [];
  const left: string[] = [];
  for (const file of [...manifest.files].reverse()) {
    try {
      if (!stillWritable(manifest.root, file.abs)) {
        left.push(`${file.rel} (outside what ship may change; not touched)`);
        continue;
      }
      const stat = fs.lstatSync(file.abs, { throwIfNoEntry: false });
      if (stat && !stat.isFile()) {
        left.push(`${file.rel} (no longer a regular file; not touched)`);
        continue;
      }
      const current = stat ? sha256(fs.readFileSync(file.abs)) : null;
      const original = file.existed ? file.sha256 : null;
      if (current === original) continue;
      if (current !== file.shipped) {
        left.push(`${file.rel} (changed after that call, so it was left as it is)`);
        continue;
      }
      if (!file.existed) {
        fs.rmSync(file.abs, { force: true });
        removed.push(file.rel);
        continue;
      }
      const bytes = readOriginal(dir, file);
      if (sha256(bytes) !== file.sha256) {
        left.push(`${file.rel} (its saved copy is damaged, so it was left as it is)`);
        continue;
      }
      fs.mkdirSync(path.dirname(file.abs), { recursive: true });
      fs.writeFileSync(file.abs, bytes, file.mode === null ? {} : { mode: file.mode });
      restored.push(file.rel);
    } catch (err) {
      left.push(`${file.rel} (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  for (const created of [...manifest.dirs].sort((a, b) => b.length - a.length)) {
    if (!isInsideDir(manifest.root, created)) continue;
    try {
      fs.rmdirSync(created);
    } catch {
      // Not empty or already gone.
    }
  }

  const parts = [`${opening} Its edits were never verified, so they were undone.`];
  if (restored.length > 0) parts.push(`Restored: ${list(restored)}.`);
  if (removed.length > 0) parts.push(`Removed (created by that call): ${list(removed)}.`);
  if (left.length > 0) parts.push(`Left as they are: ${list(left)}.`);
  if (restored.length + removed.length + left.length === 0) parts.push("Every file was already as it was before that call.");
  return { root: manifest.root, text: parts.join(" ") };
}

/** Leaves a note where every turnpack server on this machine will find it. */
function saveNote(id: string, note: RecoveryNote): void {
  try {
    const dir = notesDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${id}.json`);
    // Written under another name first: a reader must never see half a note.
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ root: note.root, text: note.text, at: Date.now() }), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  } catch {
    // The files are back either way; the note is also on stderr.
  }
}

/**
 * Undoes every unfinished call whose process is gone, newest first, so two cut-off calls that
 * changed the same file unwind in the right order. Cheap when there is nothing to do (one
 * directory listing), so it can run before every tool call. Never throws.
 */
export function recoverJournals(): RecoveryNote[] {
  const base = journalDir();
  let names: string[];
  try {
    names = fs.readdirSync(base);
  } catch {
    return [];
  }
  const records = names
    .map((name) => ({ name, match: NAME.exec(name) }))
    .filter((record): record is { name: string; match: RegExpExecArray } => record.match !== null)
    .sort((a, b) => parseInt(b.match[1] as string, 36) - parseInt(a.match[1] as string, 36));
  const notes: RecoveryNote[] = [];
  for (const { name, match } of records) {
    const id = `${match[1]}-${match[2]}-${match[3]}`;
    const dir = path.join(base, name);
    try {
      if (match[4] === "new") {
        // Never finished being written, so the workspace was never touched. Judged by age and
        // not by process ID: on a shared home folder the writer may be on another machine.
        if (Date.now() - fs.statSync(dir).mtimeMs > STALE_STAGING_MS) removeQuietly(dir);
        continue;
      }
      if (fs.existsSync(path.join(dir, SETTLED))) {
        removeQuietly(dir);
        continue;
      }
      const manifest = readManifest(dir);
      if (!manifest) continue;
      // A process ID means nothing on another machine, and neither do that machine's paths.
      if (manifest.host !== os.hostname()) continue;
      if (match[5] !== undefined) {
        // Claimed by another process for undoing. Finish the job only if that process is gone.
        const claimer = Number(match[5]);
        if (claimer !== process.pid && isAlive(claimer)) continue;
      } else {
        if (openHere.has(id)) continue;
        if (!ownerGone(manifest)) continue;
      }
      const claimed = path.join(base, `${id}.undo-${process.pid}`);
      if (dir !== claimed) {
        try {
          renameWithRetry(dir, claimed);
        } catch {
          continue; // Another process claimed it first, or it is held open: try again next time.
        }
      }
      // The owner may have settled it a moment before the claim.
      if (fs.existsSync(path.join(claimed, SETTLED))) {
        removeQuietly(claimed);
        continue;
      }
      const note = undo(manifest, claimed);
      saveNote(id, note);
      notes.push(note);
      writeDurable(path.join(claimed, SETTLED), "");
      removeQuietly(claimed);
    } catch {
      // One bad record must not stop the others.
    }
  }
  return notes;
}

/**
 * The notes left for a workspace folder (or one inside or around it), each handed out once.
 * Whichever server recovered a call, the server that next works in that folder tells the model.
 */
export function takeRecoveryNotes(root: string): string[] {
  const dir = notesDir();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  if (names.length === 0) return [];
  let real = root;
  try {
    real = fs.realpathSync(root);
  } catch {
    // A folder that cannot be resolved matches only by its spelling.
  }
  const texts: string[] = [];
  for (const name of names.sort()) {
    const file = path.join(dir, name);
    try {
      if (!name.endsWith(".json")) {
        if (Date.now() - fs.statSync(file).mtimeMs > NOTE_MAX_AGE_MS) fs.rmSync(file, { force: true });
        continue;
      }
      const note = JSON.parse(fs.readFileSync(file, "utf8")) as { root?: unknown; text?: unknown; at?: unknown };
      if (typeof note.root !== "string" || typeof note.text !== "string" || typeof note.at !== "number") continue;
      if (Date.now() - note.at > NOTE_MAX_AGE_MS) {
        fs.rmSync(file, { force: true });
        continue;
      }
      if (!isInsideDir(note.root, real) && !isInsideDir(real, note.root)) continue;
      // Removing it is taking it: if another server got there first, this throws and it is theirs.
      fs.unlinkSync(file);
      texts.push(note.text);
    } catch {
      // Unreadable, or taken by another server.
    }
  }
  return texts;
}
