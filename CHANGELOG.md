# Changelog

## 0.1.0 (2026-11-13)

Initial clean-room release of `turnpack`:

- **Core MCP Tools (`~823` schema tokens total):**
  - `pack`: parallel ripgrep/Node search, line-range & symbol slicing, globs, git status, client-aware shard spillover, and default `.env`/key redaction.
  - `ship`: pre-write validation & precondition checks, multi-file edits/writes, bounded verify execution with process-tree cleanup, and byte-exact preimage rollback (`SHIPPED_AND_VERIFIED`, `FAILED_AND_ROLLED_BACK`, `FAILED_ROLLBACK_PARTIAL`, `FAILED_KEPT_ON_DISK`).
  - `batch`: read-only JS repo inspection helper inside `node:vm` (`ctx.files`, `ctx.read`, `ctx.grep`, `ctx.outline`, `ctx.gitStatus`), with shell `exec` disabled by default.
- **Friendly Onboarding CLI:**
  - `turnpack demo`, `turnpack init`, `turnpack doctor`, `turnpack estimate`, `turnpack audit`, `turnpack uninstall`, `turnpack serve`.
- **Two-Layer Harness Support:**
  - Layer 1 standard stdio MCP (`\n` NDJSON & `Content-Length` framing) across Claude Code, Codex CLI, OMP, Cursor, Gemini CLI, OpenCode, and Grok CLI.
  - Layer 2 diff-preview auto-installer qualified Day 1 for **Claude Code**, **Codex CLI**, and **OMP (`oh-my-pi`)** (with optional cache-safe extension under `extensions/omp-turnpack.ts`).
