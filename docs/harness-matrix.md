# App compatibility

Turnpack is a standard stdio MCP server, so any MCP-capable coding app can run it. What differs between apps is where the config lives and how much tool output they show the model before truncating.

## What is supported

| App | Config file `init` writes | Inline reply cap | `init` support |
| :--- | :--- | ---: | :--- |
| **Claude Code** | `~/.claude.json` (`mcpServers`) | 24,000 bytes | Default |
| **Codex CLI** | `~/.codex/config.toml` (`[mcp_servers.turnpack]`) | 32,000 bytes | Default |
| **OMP (`oh-my-pi`)** | `~/.omp/agent/mcp.json`, plus `~/.omp/agent/extensions/turnpack.ts` | 32,000 bytes | Default |
| **Cursor** | `~/.cursor/mcp.json` | 20,000 bytes | When named (`--client cursor`) |
| **Gemini CLI** | `~/.gemini/settings.json` | 20,000 bytes | When named (`--client gemini`) |
| **OpenCode** | `~/.config/opencode/opencode.json` (`mcp`) | 20,000 bytes | When named (`--client opencode`) |
| **Grok CLI** | `~/.grok/config.toml` | 20,000 bytes | When named (`--client grok`) |
| Anything else | Add the snippet from the README by hand | 12,000 bytes | Manual |

"Default" means `npx turnpack init` configures the app when it finds it. The other four are written only when you name them or pass `--experimental`: they get less testing here, so `init` does not touch them unasked. If a path is wrong for your version of the app, please open an issue.

The inline cap is how much `pack` returns directly before moving the overflow to files. It is chosen from the client name in the MCP handshake. Override it with `TURNPACK_MAX_INLINE_BYTES` (4,000 to 44,000), or name the client yourself with `TURNPACK_CLIENT`.

## How the workspace is chosen

Turnpack confines itself to one workspace per server. It uses the first of:

1. `TURNPACK_ROOT`
2. the folders the app reports over MCP `roots` (Claude Code reports the project directory and any added with `--add-dir`)
3. `CLAUDE_PROJECT_DIR` (set by Claude Code)
4. the directory the app started the server in

If your app starts MCP servers from your home directory and supports neither `roots` nor a project variable, set `TURNPACK_ROOT` in the server's `env` block.

## What `init` does and does not do

- Shows every change before making it, and asks unless you pass `--yes`. `--dry-run` only previews.
- Copies each file to `<name>.turnpack.bak` before writing, and writes atomically.
- Leaves a config it cannot parse (comments, a syntax slip) exactly as it found it and tells you.
- Adds one MCP server entry per app. For OMP it also installs a small status-line extension that registers no prompt hooks.
- Does not edit `CLAUDE.md`, `AGENTS.md` or other rules files, and does not install hooks. See [steering.md](steering.md) if you want either.
- `npx turnpack uninstall` removes only the entries and files `init` added.
