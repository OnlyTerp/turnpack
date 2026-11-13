# What the apps already do without Turnpack

Turnpack's value is the difference between an app's default behaviour and the same app with Turnpack installed. This page records that default behaviour for Claude Code (CLI and the Claude desktop app's Code tab), Codex (CLI and desktop app), OMP (`oh-my-pi`) and Grok Build (xAI's `grok` CLI), so the rest of the docs do not claim credit for something the app already does.

Checked on 2026-11-13 against Claude Code 2.1.323 (installed binary, official docs, `CHANGELOG.md`), the `openai/codex` source at commit `69231e1`, the `can1357/oh-my-pi` source at `84f5adc`, and the `xai-org/grok-build` source at `2bdd1d6` (2026-09-29, about six weeks older than the current release). Codex desktop-app and Grok Build docs-site details come from search results, not a direct read, and are marked as such. All four apps change often: re-check before quoting this page.

## At a glance

| Default behaviour | Claude Code | Codex | OMP | Grok Build |
| :--- | :---: | :---: | :---: | :---: |
| Runs independent read/search calls in parallel | Yes | Yes (inside code-mode `exec`) | Yes | Yes |
| Prompt tells the model to batch independent calls | Yes | Yes | Yes | Subagents only |
| One read call returns several files | No | Yes, via `exec` | No (several ranges of one file) | No |
| Script tool that calls the agent's tools | Opt-in (Code Mode, experimental) | Yes (`exec`, can write) | Yes (`eval`, can write) | Subagent orchestration only (`workflow`) |
| Edits several files in one call | No | Yes (`apply_patch`) | Yes (`edit`) | No (`apply_patch` only in the non-default `codex` preset) |
| All edits checked before any write | n/a | Yes | Yes | n/a |
| Restores files if a write fails part-way | n/a | No | No | n/a |
| Runs a test in the same call as the edit | No | Only if an `exec` script does it | No (LSP diagnostics after `write`) | No (LSP diagnostics as reminders) |
| Automatically restores files when the test fails | **No** | **No** | **No** | **No** |
| Manual undo of file changes | Yes (`/rewind`) | Desktop app only | No (checkpoint/rewind covers the conversation and is off by default) | Yes (`/rewind`) |
| MCP tool schemas deferred | Yes | Not checked | Yes | Yes (model must call `search_tool` first) |

"Automatically restores files when the test fails" is the row where Turnpack adds something to every app here. For the rest, see the details below.

## What we then measured

Reading source says what an app can do. It does not say what a model does with it, so two things were checked by running the apps (2026-11-13, Windows 11).

**What each app sends an MCP server.** A logging server was connected to Claude Code 2.1.280, Codex CLI 0.166.0 and OMP 18.20.0. All three start the server in the session's working folder and pass the server's `instructions` to the model. Claude Code and OMP report their folders over MCP `roots`; Codex does not. The details are in [harness-matrix.md](harness-matrix.md).

**The same task with and without Turnpack.** Renaming a function used in five files and making the tests pass, in Claude Code with Claude Sonnet 5, three runs per arm, nothing in the prompt about Turnpack ([`bench/agent-bench.mjs`](../bench/agent-bench.mjs)):

| Arm | Model round trips | Tool calls | Time | Output tokens |
| :--- | ---: | ---: | ---: | ---: |
| Built-in tools | 6 | 13 | 23.4 s | 2,044 |
| Built-in tools, asked to batch | 5 | 13 | 23.9 s | 2,063 |
| With Turnpack | 3 | 2 | 12.7 s | 873 |

This agrees with the table above. Claude Code was already batching: 13 calls in 6 round trips, up to 9 in one, and asking it to batch harder changed nothing. The round trips Turnpack removed were the dependent ones, search then read and edit then test, which parallel calls cannot remove. Codex CLI used `pack` and one five-file `ship` in three runs out of three; a Codex arm without Turnpack could not be run on the test machine. One small task and three runs per arm is a direction, not a benchmark.

## Claude Code and Codex

| Turnpack feature | Claude Code default | Codex default | Is Turnpack's version new? |
| :--- | :--- | :--- | :--- |
| `pack`: several reads and a search in one round trip | **Already mostly covered.** The system prompt tells Claude to make independent calls in parallel, and the harness runs read-only calls at the same time (up to 10, `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`). Bash commands can be chained. | **Already covered.** Current models (GPT-6.x, GPT-5.6) run in code mode: one `exec` call runs JavaScript that can fire many searches and reads with `Promise.allSettled`, and the prompt tells the model to do exactly that. `gpt-5.5` uses parallel tool calls instead. | Partly. What is left: a search and the reads it leads to in one call, a size cap, secret-file redaction, symbol slicing, and the same behaviour in apps that do not parallelize. |
| `batch`: one read-only script over many files | **Not by default.** Code Mode (Claude writes JavaScript that calls its tools) was added in 2.1.323 as an experimental opt-in. The Workflow tool scripts subagents, not file reads. | **Already covered, and broader.** Code-mode `exec` is a JavaScript script over the tools, on by default for current models. Unlike `batch`, it can also write files and run commands. | For Claude Code, yes, until Code Mode leaves opt-in. For Codex, the difference is only that `batch` is read-only and sandboxed. |
| `ship`: multi-file edit in one call | **No.** Edit changes one file per call (MultiEdit is legacy and gone from the tool list). Parallel edits in one turn are applied independently, so one can fail while the others stay. | **Yes.** One `apply_patch` call can add, update, delete and move many files. Every hunk is checked before anything is written. An I/O error part-way through leaves the earlier files written. | For Claude Code, yes. For Codex, no: only the edit format differed, and `ship` now accepts the `apply_patch` format too, so a Codex model can keep its format and gain the test run and the rollback. |
| `ship`: run a test in the same call as the edit | **No.** Running tests after edits needs an opt-in PostToolUse or Stop hook. | **No dedicated tool.** A code-mode `exec` script *can* call `apply_patch` and then `exec_command` in one model turn, but nothing restores the files if the test fails. | Yes, as a single tool with a reported outcome. |
| `ship`: automatic rollback when the test fails | **No.** Checkpoints are taken automatically before each prompt, but restoring is manual (Esc Esc or `/rewind`), files changed only through Bash are not tracked, and nothing reverts on a failed test. | **No.** The CLI's ghost-commit `undo` feature has been removed. `thread/revert` rewinds the conversation only. The desktop app has manual revert in the diff view and worktree threads (from docs and issues, not checked directly). | **Yes.** Neither app restores files automatically when a check fails. |
| Tool schema cost | Tool search is on by default, so MCP schemas are deferred: at startup only tool names and server instructions load, unless a server marks a tool `"anthropic/alwaysLoad": true`. Turnpack now does, for its three tools, so the model can call them without a search step first. | `tool_search` exists and is parallel-safe; whether it defers MCP schemas by default was not checked. In our runs the model called `pack` with correct arguments as its first Turnpack call. | n/a. The README's schema figure (about 1,270 tokens) is what Claude Code loads at the start of a session. |

The Chat tab in Claude Desktop (not the Code tab) has no documented built-in tools for a local repository. Local file access there comes from MCP servers or desktop extensions. We could not confirm that there are none.

## OMP (`oh-my-pi`)

Source: `can1357/oh-my-pi` @ `84f5adc`, a fork of `badlogic/pi-mono`.

- **Parallel calls: yes, by default.** The agent loop runs "shared" tools concurrently and "exclusive" ones (`edit`, `write`, `eval`) one at a time (`packages/agent/src/agent-loop.ts`). The system prompt says to "batch all independent reads/searches/checks into one turn" and to "parallelize independent calls" (`packages/coding-agent/src/prompts/system/system-prompt.md:99`). One exception: the Codex provider sends `parallel_tool_calls=false`.
- **Reads:** `read` takes one path per call, though that path can carry several line ranges (`:5-16,960-973`), and the docs say to "issue one `read` per path" (`docs/tools/read.md`). `grep` and `glob` are separate default tools.
- **Edits:** one `edit` call can change several files. Every section is parsed and checked before writes begin, but "an operating-system write failure can leave the already-landed prefix applied" (`docs/tools/edit.md:163`). `ast_edit` previews, then applies on accept.
- **Scripting:** `eval` (JavaScript always, Python when an interpreter is found) is on by default and can call the agent's own tools, including MCP tools. It is not read-only: it has `write()` and can call `tool.edit` (`docs/tools/eval.md`).
- **Undo and tests:** no automatic file rollback. `checkpoint`/`rewind` act on the conversation and are off by default. The only path that reverts files is the opt-in `/autoresearch` mode, through git. No test runs after edits by default; LSP diagnostics run after `write`.
- **MCP:** built in. MCP tools are "discoverable" by default, so only a catalog goes in the prompt and schemas load on demand.
- Upstream `pi` also runs tool calls in parallel by default and has an opt-in `codemode` JavaScript tool.

**Is Turnpack's version new for OMP?** `pack`: partly (several whole files plus search, glob and git status in one call; OMP gets most of this through parallel calls or `eval`). `batch`: only in being read-only. `ship`: the multi-file edit and up-front checking already exist. What is new is running the test in the same call and restoring every file automatically when it fails or when a write fails part-way.

## Grok Build (xAI `grok` CLI)

Source: `xai-org/grok-build` @ `2bdd1d6`. This is the CLI that reads `~/.grok/config.toml`, which is where `turnpack init --client grok` writes. The community `superagent-ai/grok-cli` uses `~/.grok/user-settings.json` instead. "Grok Bot" is a separate hosted workplace agent, not a local CLI, and is out of scope here. Paths below are under `crates/codegen/`.

- **Parallel calls: yes.** The CLI leaves `parallel_tool_calls` at the API default, and approved calls from one response run concurrently. Edits take an exclusive per-file lock. The main system prompt has no instruction to batch calls; the subagent prompt does.
- **Reads:** `read_file` takes one path plus offset/limit (`xai-grok-tools/src/implementations/grok_build/read_file/mod.rs`). `grep` (ripgrep) and `list_dir` are separate.
- **Edits:** `search_replace` makes one replacement in one file. A multi-file `apply_patch` exists only in the non-default `codex` tool preset.
- **Scripting:** `workflow` runs Rhai scripts by default, but its functions start and coordinate subagents. It has no functions for reading repo files or calling tools directly.
- **Undo and tests:** `/rewind` (also `/undo`) restores files and/or the conversation to a snapshot taken before each prompt. It is manual. No test runs after edits; LSP diagnostics come back as reminders where an LSP backend is available. Test hooks are opt-in.
- **MCP:** configured under `[mcp_servers]` in `~/.grok/config.toml`. Schemas are deferred: the model is told it "MUST call `search_tool` first" before `use_tool` (`xai-grok-shell/src/session/acp_session_impl/mcp.rs:1495`). So the first Turnpack call in a Grok Build session costs one extra round trip.

**Is Turnpack's version new for Grok Build?** `pack`: partly (calls already run in parallel, but each read is one file). `batch`: yes; no default tool runs a read-only script over the repo. `ship`: yes; there is no default multi-file edit, no edit-plus-test call, and no automatic restore.

## What this means for our claims

Safe to say:

- No default tool in Claude Code, Codex, OMP or Grok Build edits, tests and restores files automatically in one step. `ship` is the part of Turnpack with no built-in equivalent in any of them.
- Turnpack restores every file if a write fails part-way. Codex's `apply_patch` and OMP's multi-file `edit` check edits up front but can leave earlier files written.
- Claude Code has no built-in tool that edits several files in one call, and its edits in a single turn are not applied as a unit.
- Claude Code has no default read-only script tool. Code Mode is experimental and opt-in as of 2.1.323.
- Turnpack gives the same tools to any MCP client and model, including ones without parallel calls or code mode.

Not safe to say:

- "Your agent makes one tool call per round trip." None of the four apps works that way by default. The 16 → 4 turn scenario in the README and calculator models an agent with no parallel calls, so it overstates the gain for all four.
- "Codex can't batch reads" or "Codex has no scripting tool." Code mode does both, by default, for current models.
- "Codex edits one file at a time" or "applies patches unchecked."
- "Neither app has undo." Both have manual undo. What they lack is automatic rollback tied to a check.
- That OMP lacks multi-file edits, up-front edit checking, a tool-calling script tool, or deferred MCP schemas, or that Grok Build lacks parallel calls, undo or any scripting. All of these exist.
- "`batch` is the only scripting tool." Codex `exec` and OMP `eval` are on by default and can do more (including writes); `batch`'s distinction is that it is read-only and sandboxed.
- Anything about Codex `read_file`, `grep_files`, `list_dir` or `/undo`. Those were removed.

## What changed in Turnpack because of this page

- The README's time section now leads with what the apps already do and with the measured run above. The 16 → 4 chart is labelled as an agent that makes one call per round trip, which none of these apps is.
- `extensions/claude-hook.mjs` also counts reads and searches made through the shell, since on macOS, Linux and WSL that is how Claude Code searches.
- `extensions/omp-turnpack.ts` also counts `glob`, `find` and `write`. `eval` is left out on purpose: one `eval` is already a batch.
- `ship` accepts a patch in Codex's `apply_patch` format or as a unified diff.
- `pack` has `context`, which returns the code around each search hit. That is the one read-side round trip parallel calls cannot remove, because the agent cannot know what to open until the search has come back.
- Turnpack's tools load with the session in Claude Code instead of behind its tool search.

Still open: the README's "Prior art" credits Code Mode ideas but does not say that Codex now uses code mode by default.

## Sources

Claude Code: `code.claude.com/docs/en/tools-reference` (Read, Edit, Glob/Grep defaults, tool list), `checkpointing` (what is tracked, manual restore), `mcp` (`readOnlyHint` and parallel calls; tool search), `hooks` and `best-practices` (test hooks are opt-in), `desktop` (worktree isolation off by default), `CHANGELOG.md` 2.1.323 (Code Mode), the installed binary (`CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` defaults to 10; system prompt asks for parallel calls). Turnpack marks `pack` and `batch` with `readOnlyHint: true` (`src/mcp-server.ts`), so Claude Code runs them in parallel with other read-only calls.

Codex (`openai/codex` @ `69231e1`): `codex-rs/models-manager/models.json` (models set to `code_mode_only`, prompt text including "Batch independent searches and reads in one functions.exec"), `codex-rs/core/src/tools/parallel.rs` and `tools/src/tool_executor.rs` (parallel-safe tools), `codex-rs/apply-patch/src/` (validate before write, no rollback on I/O error), `codex-rs/features/src/lib.rs` (ghost-commit `undo` marked removed), `codex-rs/app-server-protocol/src/protocol/v2/thread.rs` (`thread/revert` does not revert files). The bundled `models.json` is a fallback: the live models endpoint can override it. Desktop app: developers.openai.com/codex/app/review and /features, and openai/codex issue 28506 and discussion 9618.

OMP (`can1357/oh-my-pi` @ `84f5adc`) and Grok Build (`xai-org/grok-build` @ `2bdd1d6`): file paths are given inline in their sections above. Grok Build's config location is also described at docs.x.ai/build/settings.
