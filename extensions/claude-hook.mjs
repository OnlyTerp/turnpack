#!/usr/bin/env node
/**
 * Optional cache-safe PreToolUse hook helper for Claude Code / compatible harnesses.
 *
 * Design contract:
 * - Emits 0 stdout bytes on normal tool calls (adds zero per-call token overhead and never alters system prompts).
 * - Only emits a short contextual reminder when >=4 consecutive single-file micro-reads or edits occur
 *   within a 30-second burst.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const WINDOW_MS = 30000;
const MICRO_THRESHOLD = 4;
const STATE_FILE = path.join(os.tmpdir(), `turnpack-hook-${process.ppid || 0}.json`);

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  raw += c;
});
process.stdin.on("end", () => {
  let payload = {};
  try {
    payload = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    process.exit(0);
  }

  const tool = String(payload.tool_name || payload.toolName || "").trim();
  const now = Date.now();
  let state = { count: 0, lastAt: 0 };
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    // Fresh session window.
  }

  if (tool === "Read" || tool === "Grep" || tool === "Edit") {
    state.count = now - state.lastAt <= WINDOW_MS ? state.count + 1 : 1;
    state.lastAt = now;
  } else if (tool.includes("pack") || tool.includes("ship") || tool.includes("batch")) {
    state.count = 0;
    state.lastAt = now;
  }

  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state), { mode: 0o600 });
  } catch {
    // Non-fatal; never block a tool call.
  }

  if (state.count >= MICRO_THRESHOLD) {
    process.stdout.write(
      "turnpack hint: several separate file calls in a row — consider batching reads/searches with mcp__turnpack__pack or multi-file edits with mcp__turnpack__ship.\n",
    );
  }
});
