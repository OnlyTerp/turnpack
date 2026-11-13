#!/usr/bin/env node
/**
 * Optional PreToolUse hook for Claude Code. Not installed by `turnpack init`; see
 * docs/steering.md for the settings snippet if you want it.
 *
 * What it does: when the model makes several single-file calls in a row (Read, Grep, Glob,
 * Edit) inside a short window, it adds one line of context suggesting `pack` or `ship`.
 *
 * Contract:
 * - Silent on ordinary tool calls: no output, exit 0, so it adds nothing to the conversation.
 * - Speaks once per burst, then starts counting again, so it cannot nag.
 * - Uses the documented JSON form (`hookSpecificOutput.additionalContext`). Plain stdout from a
 *   PreToolUse hook goes to the debug log and never reaches the model.
 * - Never blocks or alters a tool call, and never fails one: every error path exits 0.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const WINDOW_MS = 30000;
const BURST_THRESHOLD = 4;
const SINGLE_FILE_TOOLS = new Set(["Read", "Grep", "Glob", "Edit"]);

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  raw += chunk;
});
process.stdin.on("end", () => {
  let payload;
  try {
    payload = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    process.exit(0);
  }
  if (!payload || typeof payload !== "object") process.exit(0);

  const tool = String(payload.tool_name ?? "").trim();
  const session = String(payload.session_id ?? process.ppid ?? "0").replace(/[^A-Za-z0-9_-]/g, "");
  const stateFile = path.join(os.tmpdir(), `turnpack-hook-${session || "0"}.json`);
  const now = Date.now();

  let state = { count: 0, lastAt: 0 };
  try {
    const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (Number.isFinite(saved?.count) && Number.isFinite(saved?.lastAt)) state = saved;
  } catch {
    // First call of the session.
  }

  let speak = false;
  if (SINGLE_FILE_TOOLS.has(tool)) {
    state.count = now - state.lastAt <= WINDOW_MS ? state.count + 1 : 1;
    state.lastAt = now;
    if (state.count >= BURST_THRESHOLD) {
      speak = true;
      state.count = 0;
    }
  } else if (tool.startsWith("mcp__turnpack__")) {
    state = { count: 0, lastAt: now };
  }

  try {
    fs.writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
  } catch {
    // Losing the counter is harmless.
  }

  if (speak) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext:
            "Several single-file calls in a row. If more are coming, mcp__turnpack__pack can read and search many files in one call, and mcp__turnpack__ship can apply a multi-file edit and run the tests in one call.",
        },
      }),
    );
  }
  process.exit(0);
});
