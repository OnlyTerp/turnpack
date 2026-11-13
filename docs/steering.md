# Steering your agent toward the tools

Installing an MCP server makes its tools available. It does not make a model prefer them over the read, search and edit tools it was trained on. This page covers what Turnpack does about that by default, and the two optional ways to push harder.

## What happens by default

When your app connects, Turnpack returns a short `instructions` string in the MCP handshake. Apps that support it (Claude Code does) place it in the model's context once per session:

```text
Turnpack folds multi-step file work into single calls.
- Need 2+ files, or a search plus the files it finds? Call `pack` once (query + files + globs + git_status together) instead of separate read/search calls.
- Changing 2+ files, or making any change that must pass a test or typecheck? Call `ship` once with every edit and a `verify` command. If verify fails, all files are restored automatically and you get the failing output: fix the edit and ship again.
- Need a fact about many files (counts, outlines, which files match)? Call `batch` with a short script and return only the summary.
For one small edit to a file you already have open, your normal edit tool is fine.
```

That is about 170 tokens. It is static, so it does not disturb prompt caching, and it is the only steering Turnpack does on its own. `turnpack init` does not edit `CLAUDE.md`, `AGENTS.md` or any other rules file.

How reliably a model follows it varies by model and by app, and we have no measured rate to offer. If you watch your agent read five files one at a time with Turnpack installed, use one of the options below.

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

[`extensions/claude-hook.mjs`](../extensions/claude-hook.mjs) is a `PreToolUse` hook. It stays silent on ordinary tool calls. When it sees four single-file calls (Read, Grep, Glob, Edit) within 30 seconds, it adds one line of context suggesting `pack` or `ship`, then starts counting again.

It is not installed by `turnpack init`. To use it, copy the file somewhere stable and add this to `~/.claude/settings.json` (or `.claude/settings.json` in a project):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Read|Grep|Glob|Edit|mcp__turnpack__.*",
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
