# What the apps already do without Turnpack

Turnpack's value is the difference between an app's default behaviour and the same app with Turnpack installed. This page records that default behaviour for Claude Code (CLI and the Claude desktop app's Code tab) and Codex (CLI and desktop app), so the rest of the docs do not claim credit for something the app already does.

Checked on 2026-11-13 against Claude Code 2.1.323 (installed binary, official docs, `CHANGELOG.md`) and the `openai/codex` source at commit `69231e1`. Codex desktop-app details come from OpenAI's docs pages and GitHub issues as seen through search results, not from a direct read, and are marked as such. Both apps change often: re-check before quoting this page.

## Summary

| Turnpack feature | Claude Code default | Codex default | Is Turnpack's version new? |
| :--- | :--- | :--- | :--- |
| `pack`: several reads and a search in one round trip | **Already mostly covered.** The system prompt tells Claude to make independent calls in parallel, and the harness runs read-only calls at the same time (up to 10, `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`). Bash commands can be chained. | **Already covered.** Current models (GPT-6.x, GPT-5.6) run in code mode: one `exec` call runs JavaScript that can fire many searches and reads with `Promise.allSettled`, and the prompt tells the model to do exactly that. `gpt-5.5` uses parallel tool calls instead. | Partly. What is left: a search and the reads it leads to in one call, a size cap, secret-file redaction, symbol slicing, and the same behaviour in apps that do not parallelize. |
| `batch`: one read-only script over many files | **Not by default.** Code Mode (Claude writes JavaScript that calls its tools) was added in 2.1.323 as an experimental opt-in. The Workflow tool scripts subagents, not file reads. | **Already covered, and broader.** Code-mode `exec` is a JavaScript script over the tools, on by default for current models. Unlike `batch`, it can also write files and run commands. | For Claude Code, yes, until Code Mode leaves opt-in. For Codex, the difference is only that `batch` is read-only and sandboxed. |
| `ship`: multi-file edit in one call | **No.** Edit changes one file per call (MultiEdit is legacy and gone from the tool list). Parallel edits in one turn are applied independently, so one can fail while the others stay. | **Yes.** One `apply_patch` call can add, update, delete and move many files. Every hunk is checked before anything is written. An I/O error part-way through leaves the earlier files written. | For Claude Code, yes. For Codex, no: only the edit format differs. |
| `ship`: run a test in the same call as the edit | **No.** Running tests after edits needs an opt-in PostToolUse or Stop hook. | **No dedicated tool.** A code-mode `exec` script *can* call `apply_patch` and then `exec_command` in one model turn, but nothing restores the files if the test fails. | Yes, as a single tool with a reported outcome. |
| `ship`: automatic rollback when the test fails | **No.** Checkpoints are taken automatically before each prompt, but restoring is manual (Esc Esc or `/rewind`), files changed only through Bash are not tracked, and nothing reverts on a failed test. | **No.** The CLI's ghost-commit `undo` feature has been removed. `thread/revert` rewinds the conversation only. The desktop app has manual revert in the diff view and worktree threads (from docs and issues, not checked directly). | **Yes.** Neither app restores files automatically when a check fails. |
| Tool schema cost | Tool search is on by default, so MCP schemas are deferred: at startup only tool names and server instructions load. | `tool_search` exists and is parallel-safe; whether it defers MCP schemas by default was not checked. | n/a. The README's ~1,100-token schema figure is an upper bound for Claude Code. |

The Chat tab in Claude Desktop (not the Code tab) has no documented built-in tools for a local repository. Local file access there comes from MCP servers or desktop extensions. We could not confirm that there are none.

## What this means for our claims

Safe to say:

- No default tool in Claude Code or Codex edits, tests and restores files automatically in one step. `ship` is the part of Turnpack with no built-in equivalent in either app.
- Claude Code has no built-in tool that edits several files in one call, and its edits in a single turn are not applied as a unit.
- Claude Code has no default read-only script tool. Code Mode is experimental and opt-in as of 2.1.323.
- Turnpack gives the same tools to any MCP client and model, including ones without parallel calls or code mode.

Not safe to say:

- "Your agent makes one tool call per round trip." Neither app works that way by default. The 16 → 4 turn scenario in the README and calculator models an agent with no parallel calls, so it overstates the gain for both of these apps.
- "Codex can't batch reads" or "Codex has no scripting tool." Code mode does both, by default, for current models.
- "Codex edits one file at a time" or "applies patches unchecked."
- "Neither app has undo." Both have manual undo. What they lack is automatic rollback tied to a check.
- Anything about Codex `read_file`, `grep_files`, `list_dir` or `/undo`. Those were removed.

## Known gaps in our own docs

- The time model's "without" column assumes one tool call per turn. Neither app's default behaves that way, so state this plainly wherever the 16 → 4 figure appears.
- `extensions/claude-hook.mjs` counts Read, Grep, Glob and Edit calls. On macOS, Linux and WSL, Claude Code leaves Grep and Glob out of its default tool set and searches through Bash, so the hook does not see those searches.
- The README's "Prior art" credits Code Mode ideas but does not say that Codex now uses code mode by default.

## Sources

Claude Code: `code.claude.com/docs/en/tools-reference` (Read, Edit, Glob/Grep defaults, tool list), `checkpointing` (what is tracked, manual restore), `mcp` (`readOnlyHint` and parallel calls; tool search), `hooks` and `best-practices` (test hooks are opt-in), `desktop` (worktree isolation off by default), `CHANGELOG.md` 2.1.323 (Code Mode), the installed binary (`CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` defaults to 10; system prompt asks for parallel calls). Turnpack marks `pack` and `batch` with `readOnlyHint: true` (`src/mcp-server.ts`), so Claude Code runs them in parallel with other read-only calls.

Codex (`openai/codex` @ `69231e1`): `codex-rs/models-manager/models.json` (models set to `code_mode_only`, prompt text including "Batch independent searches and reads in one functions.exec"), `codex-rs/core/src/tools/parallel.rs` and `tools/src/tool_executor.rs` (parallel-safe tools), `codex-rs/apply-patch/src/` (validate before write, no rollback on I/O error), `codex-rs/features/src/lib.rs` (ghost-commit `undo` marked removed), `codex-rs/app-server-protocol/src/protocol/v2/thread.rs` (`thread/revert` does not revert files). The bundled `models.json` is a fallback: the live models endpoint can override it. Desktop app: developers.openai.com/codex/app/review and /features, and openai/codex issue 28506 and discussion 9618.
