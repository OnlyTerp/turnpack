# Changelog

## 0.1.0

First release.

### Tools

- **`pack`**: search (ripgrep, or a built-in fallback), whole files, line ranges, symbol slices for JS/TS, Python, Rust and Go, glob listings and git status in one call. Replies are size-capped per app; what fits is returned inline and only the overflow is written to private files outside the repo. A bad path in the request is reported in place instead of failing the whole call.
  - `context` returns the lines around each search hit, grouped by file with the hits marked, so finding code and reading it is one call.
  - Files are named as plain strings: `"src/app.ts"`, `"src/app.ts:10-80"`, `"src/app.ts#handleLogin"` for one function or class, `"src/app.ts#"` for an outline. The object form still works.
  - A long file that is cut off lists the functions below the cut. A path that does not exist comes back with the files it was probably meant to be.
- **`ship`**: validates every edit, write, move and delete in memory, applies them, runs the verify command(s), and restores byte-exact snapshots if verify fails or times out. On failure the reply carries the start and the end of the output; on success, a few lines. Statuses: `SHIPPED_AND_VERIFIED`, `APPLIED_NO_VERIFY`, `ABORTED_BEFORE_WRITE`, `FAILED_AND_ROLLED_BACK`, `FAILED_ROLLBACK_PARTIAL`, `FAILED_KEPT_ON_DISK`.
  - **Edits that are right about the code and wrong about the bytes still apply.** The exact text is tried first. If it is absent, line endings, copied line numbers, trailing whitespace, indentation and typographic quotes are ignored in turn, but only when that identifies exactly one place. The replacement is re-indented to match the file, and the reply says when a looser match was used.
  - **Every problem in one reply.** A call that cannot be applied lists each edit that failed, with the closest text in the file, its line numbers and the first line that differs.
  - **`patch`**: the same change as one patch, in the `apply_patch` format or as a unified diff. Hunks are placed by their context, in order; line numbers are ignored.
  - **`moves`**: rename or move a file, and edit it under its new name in the same call. Rollback moves it back.
  - Accepts the argument names of other edit tools (`old_string`/`new_string`, `file_path`, `oldText`/`newText`), and lists passed as JSON text. An unknown argument that carries a list or a long string is refused instead of ignored.
  - When no `verify` is given and the project declares a check, the reply names it.
- **`batch`**: a short read-only script over the repo with `ctx.files`, `ctx.read`, `ctx.outline`, `ctx.grep` and `ctx.gitStatus`. Results over 48 KB are truncated with a note.

### Safety

- **Workspace jail fixed on the server side.** The boundary comes from `TURNPACK_ROOT`, MCP `roots`, `CLAUDE_PROJECT_DIR` or the launch directory, in that order. The `root` tool argument (also accepted as `cwd`) can choose a subdirectory and nothing else.
- **A home directory is never a workspace.** A server started in a home directory, a file system root, a system or application folder or a credentials folder has no workspace. Each call must then name its project folder, is confined to it, and cannot name one of those broad folders. `TURNPACK_ROOT` pins the folder instead.
- **`CLAUDE_PROJECT_DIR` is believed only from Claude.** Another app started from a Claude Code terminal inherits the variable; it no longer decides that app's workspace.
- **`batch` runs in its own process** under Node's permission model (no writes, no child processes, no workers, reads limited to the workspace), in a `node:vm` context that receives no host objects, with a minimal environment and a wall-clock limit enforced by the parent. The process does not sit in the workspace directory, so on Windows it never blocks that folder from being renamed or removed.
- **Secret shield** for `.env*`, keys, registry and cloud credentials, Terraform state and similar files.
- **Protected paths**: `ship` never writes a `.turnpack.json` or anything inside a `.git` directory, at any depth.
- **Windows path aliases refused.** NTFS stream syntax (`.env::$DATA`, `.git::$INDEX_ALLOCATION`), names ending in a dot or a space, and 8.3 short names are rejected with `ERR_PATH_ALIAS` in every tool, in file paths and in `root` / `cwd`, so a protected or secret file cannot be reached under a second name.
- **Verify allowlist** (optional, `.turnpack.json`): commands must match an entry exactly; an entry ending in ` *` opts in to plain trailing arguments. Shell operators are refused, an invalid config file blocks verify instead of disabling the list, and the list applies to every subdirectory a call can name as its `cwd`.
- **Rollback on interruption**: SIGINT, SIGTERM and SIGHUP during verify restore the snapshots before the server exits.
- **Rollback leaves your changes alone.** A file that something else changed while verify was running is not overwritten by the snapshot. The rest are restored and the reply is `FAILED_ROLLBACK_PARTIAL`, naming the file.
- `ship` returns when the verify command exits, even if the command left a background process holding its output open, so one such command cannot stall the calls queued behind it.
- Search patterns are passed to ripgrep as data, so a query that starts with `-` is searched for rather than parsed as an option.
- Dangling symlinks are followed before the boundary checks, so a link to a not-yet-existing file cannot carry a write outside the workspace or into `.git`.
- The built-in regex search and glob matching run in a worker thread with a deadline, so a pattern with catastrophic backtracking costs one call instead of freezing the server.
- Concurrent `ship` calls are queued. Edits to files that are not valid UTF-8 are refused.

### MCP server

- stdio transport with newline-delimited and `Content-Length` framing.
- Protocol version negotiation; `instructions` in the handshake so models know when to use each tool; tool annotations (`readOnlyHint` for `pack` and `batch`).
- The instructions name the project's own check command when it can be read from the project (`package.json` scripts, `Cargo.toml`, `go.mod`, `pytest` config, a `Makefile`, or an enforced `.turnpack.json`).
- Tools carry `"anthropic/alwaysLoad": true`, so Claude Code shows them to the model at the start of a session instead of behind its tool search.
- Tool schemas use plain types only (no `oneOf`, no type lists), so they pass unchanged through model APIs that drop or reject unions. The tools still accept the richer shapes.
- Progress notifications while a verify command runs, for clients that ask for them.
- `TURNPACK_LOG=<file>`: an opt-in local log with one line per tool call and no arguments or contents.
- JSON-RPC errors for malformed input and unknown tools; lenient argument handling for common model slips (a string where a list was expected).
- Version reported from `package.json`.

### CLI

- `turnpack demo`: a five-step walkthrough in a throwaway temp repo.
- `turnpack doctor`: checks Node, ripgrep, the MCP handshake, the schema size, the secret shield, the workspace jail and the `batch` isolation mode. It then reads each AI app's config and starts the server exactly as that app would, so a stale entry is reported as a failure with its fix.
- `turnpack init` / `uninstall`: preview, backup, atomic write. Configs that cannot be parsed are left untouched, and so are keys you added to an existing entry, the file's indentation and its line endings.
  - Claude Code, Claude Desktop, Codex (CLI and the ChatGPT desktop app), OMP and Grok Build by default; Cursor, Gemini CLI and OpenCode when named.
  - The entry starts a file on this machine with an absolute path to Node: fast, offline, and pinned. A copy run from a package runner's cache is first copied to `~/.turnpack/versions/<version>`. `--npx` writes `npx -y turnpack@<version> serve` instead (through `cmd /c` on Windows, where `npx` is a batch file).
  - After writing, `init` starts the server with that command and reports whether it answered.
  - Codex, OMP and Grok Build entries get a ten-minute tool timeout, so a verify command longer than those apps' default is not cut off.
  - `--client claude-desktop --root <folder>` pins the project folder for an app that has none.
- `turnpack.mcpb`: a one-click bundle for Claude Desktop, attached to each release (`npm run bundle` builds it).
- `turnpack estimate`, `turnpack audit`, `turnpack serve`.

### Project

- Licensed under the Apache License 2.0, with a `NOTICE` file that travels with every copy: the npm package, the Claude Desktop bundle, and the copy `init` makes under `~/.turnpack`.
- Zero runtime dependencies, strict TypeScript, tests on Linux, macOS and Windows with Node 22 and 24.
- `bench/agent-bench.mjs`: a model-in-the-loop comparison of the same task with and without Turnpack, through the agent CLIs you have installed. The first measured run is in the README.
- `docs/baselines.md`: what Claude Code, Codex, OMP and Grok Build already do without Turnpack, so the docs claim only the difference.
- The optional Claude Code hook also counts reads and searches made through the shell, and the OMP status-line extension counts `glob`, `find` and `write` as well.
- `npx github:OnlyTerp/turnpack` works from a clone (the package builds itself on install).
