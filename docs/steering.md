# Steering your agent toward the tools

Installing an MCP server makes its tools available. It does not make a model prefer them over the read, search and edit tools it was trained on. This page covers what Turnpack does about that by default, and the two optional ways to push harder.

## What happens by default

When your app connects, Turnpack returns a short `instructions` string in the MCP handshake. Claude Code, Codex and OMP place it in the model's context once per session (we checked each by asking the model to quote it):

```text
Turnpack folds multi-step file work into single calls.
- Need 2+ files, or a search plus the code around what it finds? Call `pack` once (query + context + files + globs + git_status together) instead of separate read/search calls.
- Changing 2+ files, or making any change that must pass a test or typecheck? Call `ship` once with every edit (search/replace `edits`, or one `patch` in apply_patch or unified-diff format) and a `verify` command. If verify fails, all files are restored automatically and you get the failing output: fix the edit and ship again.
- Need a fact about many files (counts, outlines, which files match)? Call `batch` with a short script and return only the summary.
For one small edit to a file you already have open, your normal edit tool is fine.
This project's check: `npm test` (from package.json). Use it as ship's verify.
```

The last line is the only part that varies. The server looks in the project it was started in for a check command (a `test` or `typecheck` script in `package.json`, `cargo check`, `go test ./...`, `pytest`, a `make test` target, or the entries of an enforced `.turnpack.json` allowlist) and names what it finds. Knowing the command is what makes a model use `ship` with a `verify` instead of editing first and testing later. The whole text is about 230 tokens and is the same on every session in a project, so it does not disturb prompt caching. It is the only steering Turnpack does on its own: `turnpack init` does not edit `CLAUDE.md`, `AGENTS.md` or any other rules file.

**Claude Code hides MCP tools by default.** It shows the model a server's tool names and makes it search for a tool before the first call. That extra step is the usual reason a model with an MCP server installed keeps using its built-in tools. Claude Code lets a server ask for a tool to be loaded with the session (`"anthropic/alwaysLoad": true` on the tool), and Turnpack asks for all three. If you would rather keep them deferred, set `"alwaysLoad": false` on the Turnpack entry in your Claude Code config.

How reliably a model follows the instructions varies by model and by app. In the runs we measured (Claude Code with Sonnet 5, Codex CLI 0.166, three runs each, nothing in the prompt about Turnpack) the model used `pack` and `ship` every time; see the README. If your agent reads five files one at a time with Turnpack installed, use one of the options below.

## Option 1: a line in your rules file

Add this to `CLAUDE.md`, `AGENTS.md`, `.cursorrules` or whatever your app reads. Rules files carry more weight than tool descriptions.

```markdown
## File work

- To look at two or more files, or to search and then read, use the `pack` tool once instead of separate reads and searches.
- To change two or more files, or to make any change that should pass `npm test`, use the `ship` tool once with all the edits and `verify: "npm test"`. If it reports FAILED_AND_ROLLED_BACK, the files are back to how they were: read the output, fix the edit, and ship again.
- For a question about many files, use `batch` and return a summary.
```

Replace `npm test` with your project's fast check. Naming the real command matters more than anything else here: an agent that knows the verify command will use `ship`, and one that has to guess often will not.

## Option 2: a Claude Code hook that speaks up during a burst

[`extensions/claude-hook.mjs`](../extensions/claude-hook.mjs) is a `PreToolUse` hook. It stays silent on ordinary tool calls. When it sees four single-file calls within 30 seconds, it adds one line of context suggesting `pack` or `ship`, then starts counting again. A single-file call is Read, Grep, Glob, Edit or Write, or a shell command that reads or searches (`rg`, `grep`, `cat`, `ls` and the like): on macOS, Linux and WSL, Claude Code has no Grep or Glob tool by default and searches through the shell.

It is not installed by `turnpack init`. To use it, copy the file somewhere stable and add this to `~/.claude/settings.json` (or `.claude/settings.json` in a project):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Read|Grep|Glob|Edit|Write|Bash|PowerShell|mcp__turnpack__.*",
        "hooks": [{ "type": "command", "command": "node /absolute/path/to/claude-hook.mjs" }]
      }
    ]
  }
}
```

Things to know before you turn it on:

- A hook runs on every matching tool call, so it adds a Node start-up (tens of milliseconds) to each one.
- The line it adds is new context in the middle of a session. It is small and rare by design, but it is not free.
- It has been tested for what it prints and when. It has not been measured for how much it changes model behaviour.

Option 1 is cheaper and usually enough. Try it first.

## Checking whether it is working

Ask your agent to do something that obviously spans files, such as renaming a function used in three places and running the tests, and watch which tools it calls. If you see one `pack` and one `ship`, you are done. If you see a string of single reads and edits, add the rules snippet.

To check without watching, set `TURNPACK_LOG` to a file path in the server's `env` block. The server then appends one line per call: the time, the tool, how long it took, whether it succeeded, the size of the reply and, for `ship`, the outcome. It never records arguments, paths or file contents, and it stays on your machine.

```json
{"t":"2026-11-13T11:02:51.404Z","tool":"pack","ms":41,"ok":true,"bytes":1873}
{"t":"2026-11-13T11:02:58.960Z","tool":"ship","ms":318,"ok":true,"bytes":229,"status":"SHIPPED_AND_VERIFIED"}
```

To compare whole runs with and without Turnpack on your own setup, see [bench/README.md](../bench/README.md).

## Headless Codex

`codex exec` and Codex automations refuse an MCP tool call that needs approval, since nobody is there to give it. `pack` and `batch` are marked read-only; `ship` is not. To let `ship` run unattended, add this to the Turnpack block in `~/.codex/config.toml`:

```toml
default_tools_approval_mode = "approve"
```

`init` keeps that line when you run it again, and never adds it for you.
