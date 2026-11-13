# Harness Compatibility Matrix (`v0.1.0`)

Turnpack uses a **Two-Layer Harness Strategy** so any MCP-capable coding app works cleanly on Day 1 without risky dotfile tampering:

## Layer 1 — Standard Stdio MCP (Works Everywhere Day 1)

| AI App | Framing & Wire Support | Measured / Configured Inline Cap | Read Hint | Status |
| :--- | :--- | ---: | :--- | :--- |
| **Claude Code** | Stdio JSON-RPC (`\n` & `Content-Length`) | 24,000 bytes | `Read` | Verified Tier 1 |
| **Codex CLI** | Stdio JSON-RPC | 32,000 bytes | `fs/read` | Verified Tier 1 |
| **OMP (`oh-my-pi`)** | Stdio JSON-RPC + `ExtensionAPI` | 32,000 bytes | `read` | Verified Tier 1 |
| **Cursor** | Stdio JSON-RPC | 20,000 bytes | `Read` | Layer 1 + `--experimental` |
| **Gemini CLI** | Stdio JSON-RPC | 20,000 bytes | `read_file` | Layer 1 + `--experimental` |
| **OpenCode** | Stdio JSON-RPC | 20,000 bytes | `Read` | Layer 1 + `--experimental` |
| **Grok CLI** | Stdio JSON-RPC | 20,000 bytes | `Read` | Layer 1 + `--experimental` |
| **Custom MCP Clients** | Stdio JSON-RPC | 12,000 bytes (`TURNPACK_MAX_INLINE_BYTES`) | `Read` | Layer 1 Manual Snippet |

## Layer 2 — Auto-Installer (`npx turnpack init`) & Hooks

- **Verified Tier 1 (Default `npx turnpack init`):**
  - **Claude Code:** writes `mcpServers.turnpack` into `~/.claude.json` cleanly with `.turnpack.bak` backup.
  - **Codex CLI:** appends `[mcp_servers.turnpack]` to `~/.codex/config.toml` cleanly without touching sibling entries.
  - **OMP (`oh-my-pi`):** updates `~/.omp/agent/mcp.json` and installs the standalone cache-safe TypeScript plugin (`extensions/omp-turnpack.ts`), which never registers `before_agent_start` system-prompt mutations.
- **Experimental MCP-Only (`--experimental`):** registers ONLY the stdio MCP entry for **Cursor**, **Gemini CLI**, **OpenCode**, and **Grok CLI** while skipping fragile external hook dialect rewrites.
- **Clean Removal:** `npx turnpack uninstall` removes only Turnpack-owned config entries and extensions.
