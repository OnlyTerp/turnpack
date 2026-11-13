# App compatibility

Turnpack is a standard stdio MCP server, so any MCP-capable coding app can run it. What differs between apps is where the config lives, how the app tells a server which project is open, whether it shows the model a server's tools up front, and how long it lets a tool call run.

## What `init` configures

| App | Config file `init` writes | What it adds beyond the launch command | `init` support |
| :--- | :--- | :--- | :--- |
| **Claude Code** (CLI and the desktop app's Code tab) | `~/.claude.json` (`mcpServers`) | `"type": "stdio"` | Default |
| **Claude Desktop** (chats) | `claude_desktop_config.json` in the app's data folder¹ | `env.TURNPACK_ROOT` when you pass `--root` | Default |
| **Codex CLI and the ChatGPT desktop app** | `~/.codex/config.toml` (`[mcp_servers.turnpack]`) | `startup_timeout_sec = 20`, `tool_timeout_sec = 600` | Default |
| **OMP (`oh-my-pi`)** | `~/.omp/agent/mcp.json`, plus `~/.omp/agent/extensions/turnpack.ts` | `"type": "stdio"`, `"timeout": 600000` | Default |
| **Grok Build** (xAI's `grok` CLI) | `~/.grok/config.toml` (`[mcp_servers.turnpack]`) | `enabled = true`, `startup_timeout_sec = 20`, `tool_timeout_sec = 600` | Default |
| **Cursor** | `~/.cursor/mcp.json` | | When named (`--client cursor`) |
| **Gemini CLI** | `~/.gemini/settings.json` | | When named (`--client gemini`) |
| **OpenCode** | `~/.config/opencode/opencode.json` (`mcp`) | | When named (`--client opencode`) |
| Anything else | Add the snippet from the README by hand | | Manual |

¹ `%APPDATA%\Claude` on Windows, `~/Library/Application Support/Claude` on macOS, `~/.config/Claude` on Linux. Claude Desktop can also install Turnpack from the `turnpack.mcpb` file attached to each release, with no config editing.

"Default" means `npx turnpack init` configures the app when it finds it. The last three are written only when you name them or pass `--experimental`: they get less testing here, so `init` does not touch them unasked. If a path is wrong for your version of an app, please open an issue.

The timeouts are there because Codex and Grok Build stop waiting for an MCP tool after 60 seconds by default, and `ship` may be running your tests for longer than that. If you already set a value of your own in the entry, `init` keeps it.

## What each app tells the server

Measured on 2026-11-13 by connecting a logging MCP server to each CLI. "Reports folders" is the MCP `roots` capability.

| App (version) | Starts the server in | Reports folders | Passes server instructions to the model | Shows tool schemas up front |
| :--- | :--- | :--- | :--- | :--- |
| Claude Code 2.1.280 | the project folder, and sets `CLAUDE_PROJECT_DIR` | Yes | Yes | Only if the server asks. Turnpack asks (`anthropic/alwaysLoad`), so its tools are there from the first turn. |
| Codex CLI 0.166.0 | the session's working folder (the `-C` folder, not where `codex` was launched) | No | Yes | Yes in the runs we made |
| OMP 18.20.0 | the session's working folder | Yes | Yes | No, according to its source: a catalog, with schemas loaded on first use |
| Grok Build 1.0.77 | not measured² | not measured² | not measured² | No, according to its source: the model has to search for a tool before it can call it |
| Claude Desktop (chats) | not a project: the app has none | not measured | not measured | not measured |

² Grok Build does not start a project-level server in a folder it has not been told to trust, and we did not change the user-level config of the machine used for these checks. Its documented behaviour is in [baselines.md](baselines.md).

Two things follow from this table:

- In Codex, Turnpack gets its workspace from where the session runs, and that is correct. Claude Code and OMP also say it explicitly.
- Headless Codex (`codex exec`, automations) refuses MCP tool calls that need approval, because nobody is there to approve them. To use `ship` in such runs, add `default_tools_approval_mode = "approve"` to `[mcp_servers.turnpack]`. `init` does not write that for you: it widens what the model may do without asking, and that is your decision.

## How the workspace is chosen

Turnpack confines itself to one workspace per server. It uses the first of:

1. `TURNPACK_ROOT`
2. the folders the app reports over MCP `roots`
3. `CLAUDE_PROJECT_DIR`, when the client that connected is Claude (the variable is inherited by any app started from a Claude Code terminal, and for that app it names the wrong folder)
4. the directory the app started the server in, if that directory could be a project

A home directory, a drive or file system root, an operating system or application folder, and folders that hold credentials (`~/.ssh`, `~/.aws` and similar) are never a workspace. If the server is started in one of those and nothing above applies, it has no workspace: every call must then pass `root`, the absolute path of the project folder, and is confined to that folder. Turnpack says so in its instructions and marks `root` as required in its tool schemas, so the model knows to pass it. This is how it works in a chat app with no project, such as Claude Desktop without a pinned folder. To pin one instead:

```bash
npx turnpack init --client claude-desktop --root /path/to/your/project
```

## Reply size

`pack` returns what fits inline and moves the overflow to private files. The inline cap is chosen from the client name in the MCP handshake: 24,000 bytes for Claude, 32,000 for Codex and OMP, 20,000 for Cursor, Gemini CLI, OpenCode and Grok Build, 12,000 for anything else. Override it with `TURNPACK_MAX_INLINE_BYTES` (4,000 to 44,000), or name the client yourself with `TURNPACK_CLIENT`.

## What `init` does and does not do

- Shows every change before making it, and asks unless you pass `--yes`. `--dry-run` only previews.
- Writes a launch that does not depend on `npx`, a network or your `PATH`: an absolute path to Node and to Turnpack's `cli.js`. A global install or a checkout is used where it is. A copy that came from a package runner's cache (`npx`, `pnpm dlx`, `bunx`) is first copied to `~/.turnpack/versions/<version>`. `--npx` writes `npx -y turnpack@<version> serve` instead (`cmd /c npx …` on Windows, where `npx` is a batch file that many apps cannot start directly).
- Starts the server with the command it wrote and reports whether it answered (`--no-check` skips this).
- Copies each file to `<name>.turnpack.bak` before writing, and writes atomically.
- Keeps what is yours: other servers, keys you added to the Turnpack entry, the file's indentation and line endings.
- Leaves a config it cannot parse (comments, a syntax slip) exactly as it found it and tells you.
- For OMP it also installs a small status-line extension that registers no prompt hooks.
- Does not edit `CLAUDE.md`, `AGENTS.md` or other rules files, does not install hooks, and does not change any app's approval settings. See [steering.md](steering.md) if you want the first two.
- `npx turnpack uninstall` removes only the entries and files `init` added, including `~/.turnpack/versions`.

`npx turnpack doctor` reads the same config files and starts each app's entry for real. An entry that points at a Node version you have since removed shows up there as a failure, with the fix.
