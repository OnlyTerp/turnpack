# Changelog

## 0.1.0

First release.

### Tools

- **`pack`**: search (ripgrep, or a built-in fallback), whole files, line ranges, symbol slices for JS/TS, Python, Rust and Go, glob listings and git status in one call. Replies are size-capped per app; what fits is returned inline and only the overflow is written to private files outside the repo. A bad path in the request is reported in place instead of failing the whole call.
- **`ship`**: validates every edit, write and delete in memory, applies them, runs the verify command(s), and restores byte-exact snapshots if verify fails or times out. Supports file deletes, so a file move ships as one change. LF anchors match CRLF files. On failure the reply carries the start and the end of the output; on success, a few lines. Statuses: `SHIPPED_AND_VERIFIED`, `APPLIED_NO_VERIFY`, `ABORTED_BEFORE_WRITE`, `FAILED_AND_ROLLED_BACK`, `FAILED_ROLLBACK_PARTIAL`, `FAILED_KEPT_ON_DISK`.
- **`batch`**: a short read-only script over the repo with `ctx.files`, `ctx.read`, `ctx.outline`, `ctx.grep` and `ctx.gitStatus`. Results over 48 KB are truncated with a note.

### Safety

- **Workspace jail fixed on the server side.** The boundary comes from `TURNPACK_ROOT`, MCP `roots`, `CLAUDE_PROJECT_DIR` or the launch directory, in that order. The `root` / `cwd` tool argument can choose a subdirectory and nothing else.
- **`batch` runs in its own process** under Node's permission model (no writes, no child processes, no workers, reads limited to the workspace), in a `node:vm` context that receives no host objects, with a minimal environment and a wall-clock limit enforced by the parent. The process does not sit in the workspace directory, so on Windows it never blocks that folder from being renamed or removed.
- **Secret shield** for `.env*`, keys, registry and cloud credentials, Terraform state and similar files.
- **Protected paths**: `ship` never writes a `.turnpack.json` or anything inside a `.git` directory, at any depth.
- **Verify allowlist** (optional, `.turnpack.json`): commands must match an entry exactly; an entry ending in ` *` opts in to plain trailing arguments. Shell operators are refused, an invalid config file blocks verify instead of disabling the list, and the list applies to every subdirectory a call can name as its `cwd`.
- **Rollback on interruption**: SIGINT, SIGTERM and SIGHUP during verify restore the snapshots before the server exits.
- Search patterns are passed to ripgrep as data, so a query that starts with `-` is searched for rather than parsed as an option.
- Dangling symlinks are followed before the boundary checks, so a link to a not-yet-existing file cannot carry a write outside the workspace or into `.git`.
- The built-in regex search and glob matching run in a worker thread with a deadline, so a pattern with catastrophic backtracking costs one call instead of freezing the server.
- Concurrent `ship` calls are queued. Edits to files that are not valid UTF-8 are refused.

### MCP server

- stdio transport with newline-delimited and `Content-Length` framing.
- Protocol version negotiation; `instructions` in the handshake so models know when to use each tool; tool annotations (`readOnlyHint` for `pack` and `batch`).
- JSON-RPC errors for malformed input and unknown tools; lenient argument handling for common model slips (a string where a list was expected).
- Version reported from `package.json`.

### CLI

- `turnpack demo`: a five-step walkthrough in a throwaway temp repo.
- `turnpack doctor`: checks Node, ripgrep, the MCP handshake, the schema size, the secret shield, the workspace jail and the `batch` isolation mode.
- `turnpack init` / `uninstall`: preview, backup, atomic write. Configs that cannot be parsed are left untouched. On Windows the server entry goes through `cmd /c`, because `npx` is a batch file there. Claude Code, Codex CLI and OMP by default; Cursor, Gemini CLI, OpenCode and Grok CLI when named.
- `turnpack estimate`, `turnpack audit`, `turnpack serve`.

### Project

- Zero runtime dependencies, strict TypeScript, tests on Linux, macOS and Windows with Node 22 and 24.
- `npx github:OnlyTerp/turnpack` works from a clone (the package builds itself on install).
