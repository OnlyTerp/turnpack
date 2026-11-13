# Recipe 3: native Windows, no WSL

Turnpack runs directly on Windows 10 and 11. From PowerShell or Windows Terminal:

```powershell
npx turnpack demo
```

```powershell
npx turnpack doctor
```

```powershell
npx turnpack init
```

What is handled for you:

- **Paths.** The workspace check understands drive letters and case-insensitive names, so `D:\` cannot be reached from a workspace on `C:\`.
- **Line endings.** A `ship` edit written with `\n` matches a file that uses `\r\n`, and the file keeps its `\r\n`.
- **Runaway tests.** A verify command that exceeds its time limit is stopped with `taskkill /T /F`, which takes its child processes with it.
- **Starting the server.** On Windows `npx` is a batch file (`npx.cmd`), and many AI apps start MCP servers without a shell, where a batch file is "program not found". `init` sidesteps this by writing the full path to `node.exe` and to Turnpack's `cli.js`. If you add an `npx` entry by hand, or use `init --npx`, the form that works is `"command": "cmd"` with `"args": ["/c", "npx", "-y", "turnpack", "serve"]`.
- **Other names for the same file.** `.env::$DATA`, a trailing dot or space, and 8.3 short names are refused, so a protected or secret file cannot be reached under a second spelling.
- **Config locations.** `init` reads and writes the same per-user config files your AI app uses on Windows, under your user profile.

One difference from macOS and Linux: Windows has no equivalent of SIGTERM, so if the server process is ended abruptly while a verify command is running, the rollback that would run on other systems does not get the chance. Ctrl+C in a console is still handled.

If `doctor` reports `batch isolation` as "own process only", your Node build could not start the script runner with Node's permission model. `batch` still works and still runs in its own process; see [SECURITY.md](../../SECURITY.md) for what that changes.
