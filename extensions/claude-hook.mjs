#!/usr/bin/env node
/**
 * Optional PreToolUse hook for Claude Code. Not installed by `turnpack init`; see
 * docs/steering.md for the settings snippet if you want it.
 *
 * What it does: when the model makes several single-file calls in a row inside a short window,
 * it adds one line of context suggesting `pack` or `ship`. A single-file call is Read, Grep,
 * Glob, Edit or Write, or a shell command that reads or searches (rg, grep, cat, ls and the
 * like). The shell counts because on macOS, Linux and WSL Claude Code has no Grep or Glob tool
 * by default and searches through Bash.
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
const SINGLE_FILE_TOOLS = new Set(["Read", "Grep", "Glob", "Edit", "Write"]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
// A shell command that only looks at files. An optional leading "cd dir &&" is allowed.
const SHELL_LOOK =
  /^\s*(?:cd\s+\S+\s*(?:&&|;)\s*)?(?:rg|grep|egrep|fgrep|git\s+grep|ag|ack|find|fd|ls|dir|tree|cat|bat|head|tail|sed\s+-n|wc|type|get-content|gc|select-string|sls|get-childitem|gci)\b/i;

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

  const command = typeof payload.tool_input?.command === "string" ? payload.tool_input.command : "";
  const singleFile = SINGLE_FILE_TOOLS.has(tool) || (SHELL_TOOLS.has(tool) && SHELL_LOOK.test(command));

  let speak = false;
  if (singleFile) {
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
            "Several single-file calls in a row. If more are coming: mcp__turnpack__pack returns a search with the code around each hit, plus any files, in one call, and mcp__turnpack__ship applies a multi-file edit, runs the tests, and undoes the edit if they fail.",
        },
      }),
    );
  }
  process.exit(0);
});
