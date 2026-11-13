<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/hero-dark.svg" />
  <source media="(prefers-color-scheme: light)" srcset="assets/hero-light.svg" />
  <img alt="Turnpack — Fewer back-and-forth AI turns" src="assets/hero-dark.svg" width="100%" />
</picture>

<br /><br />

[![CI](https://github.com/OnlyTerp/turnpack/actions/workflows/ci.yml/badge.svg)](https://github.com/OnlyTerp/turnpack/actions/workflows/ci.yml)
![Zero Dependencies](https://img.shields.io/badge/dependencies-0-10B981?style=flat-square)
![No API Keys](https://img.shields.io/badge/API%20keys-none%20required-38BDF8?style=flat-square)
![Node 22+](https://img.shields.io/badge/node-%3E%3D22-0F172A?style=flat-square)
![License MIT](https://img.shields.io/badge/license-MIT-64748B?style=flat-square)

**[See Why It Helps](#why-your-ai-feels-slow-in-plain-english)** · **[Watch 5-Second Demo](#watch-it-work-and-try-it-safely-in-5-seconds)** · **[60-Second Setup](#set-it-up-in-60-seconds)** · **[Time Saved Visualizer](#how-much-time-does-it-save)** · **[Safety & Security](#why-you-can-trust-it-on-real-projects)**

</div>

---

## Why Your AI Feels Slow (In Plain English)

Even the smartest coding AI normally spends most of its clock **waiting on back-and-forth turns**, not thinking:

1. Ask to change a feature → the AI pauses to search where a function lives.
2. Wait → it opens file #1.
3. Wait → it opens file #2, file #3, and your tests one by one.
4. Wait → it edits two files, runs your tests, fails, and leaves half-edited files broken on disk.

**Turnpack fixes the loop locally on your computer with 3 focused tools:**
- **`pack`** grabs searches, multiple file slices, globs, and git status together in one bounded step — while automatically hiding `.env` files and private keys.
- **`ship`** validates edits before writing, applies multi-file changes, runs your tests, and **automatically restores every file byte-for-byte** if a test fails.
- **`batch`** lets your AI filter or outline dozens of files in one quick read-only script instead of flooding your chat window.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/how-it-works-dark.svg" />
  <source media="(prefers-color-scheme: light)" srcset="assets/how-it-works-light.svg" />
  <img alt="Normal AI round-trip loop vs Turnpack two-step pack and ship" src="assets/how-it-works-dark.svg" width="100%" />
</picture>

---

## Watch It Work — and Try It Safely in 5 Seconds

Want to verify Turnpack **without touching a single file in your repo or changing any AI config**? Run the built-in sandbox walkthrough:

```bash
npx turnpack demo
```

It spins up a throwaway folder in your system temp directory, shows secret shielding, catches a failing test + proves byte-exact rollback, ships a verified multi-file edit, and cleans up automatically.

<div align="center">
  <img src="assets/demo.gif" alt="Live terminal recording of npx turnpack demo and doctor" width="88%" />
</div>

---

## Set It Up in 60 Seconds

Run these two commands once (Node.js `22+` required, zero API keys):

```bash
npx turnpack init
npx turnpack doctor
```

`npx turnpack init` shows a readable preview of every config change first and saves `.turnpack.bak` backups before writing. It never injects rules into your `CLAUDE.md` or `AGENTS.md`, and `npx turnpack uninstall` removes only Turnpack entries.

<details>
<summary><strong>Click for per-app setup & manual copy-paste snippets (Claude Code, Codex, OMP, Cursor, Gemini CLI, OpenCode, Grok CLI)</strong></summary>

### Verified Tier-1 Auto-Setup (`npx turnpack init`)

- **Claude Code (`~/.claude.json`)**:
  ```json
  {
    "mcpServers": {
      "turnpack": {
        "command": "npx",
        "args": ["-y", "turnpack", "serve"]
      }
    }
  }
  ```
- **Codex CLI (`~/.codex/config.toml`)**:
  ```toml
  [mcp_servers.turnpack]
  command = "npx"
  args = ["-y", "turnpack", "serve"]
  ```
- **OMP / `oh-my-pi` (`~/.omp/agent/mcp.json` + optional cache-safe plugin)**:
  ```bash
  npx turnpack init --client omp --yes
  ```
  Installs both the MCP entry and the standalone `ExtensionAPI` plugin (`extensions/omp-turnpack.ts`), which never mutates system prompts or breaks prompt caching.

### Experimental MCP-Only Auto-Setup (`--experimental`) or Copy-Paste

```bash
# Registers only the MCP server entry without altering host hook dialects:
npx turnpack init --client cursor --experimental --yes
npx turnpack init --client gemini --experimental --yes
npx turnpack init --client opencode --experimental --yes
npx turnpack init --client grok --experimental --yes
```

See [docs/harness-matrix.md](docs/harness-matrix.md) for exact file paths, framing support, and client inline caps.

</details>

---

## How Much Time Does It Save?

Every eliminated search/read/retry round-trip cuts another **model thinking pause** out of your task — plus saves manual cleanup time when `ship` catches a failing test early.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/time-saved-dark.svg" />
  <source media="(prefers-color-scheme: light)" srcset="assets/time-saved-light.svg" />
  <img alt="Visual chart showing AI waiting time saved across small, medium, and large tasks" src="assets/time-saved-dark.svg" width="100%" />
</picture>

- **Test with your own numbers in your terminal:**
  ```bash
  npx turnpack estimate --prompts 20 --size medium --turn-sec 8
  ```
- **Open the interactive visual slider page:** [docs/calculator.html](docs/calculator.html) *(and math breakdown in [docs/time-calculator.md](docs/time-calculator.md))*

### Measured Local Engine Overhead (42-File Fixture, Node v24.16.0)

These are **real measured local execution timings** from `node bench/run-local-bench.mjs` and `npx turnpack doctor --json` *(not synthetic AI benchmark claims — see [bench/README.md](bench/README.md) for our 3-arm LLM eval protocol)*:

| Check / Operation | Measured Result | What It Means for You |
| :--- | ---: | :--- |
| **`tools/list` schema footprint** | `3,289` bytes (`~823` tokens) | Minimal context tax across all 3 tools (`pack`, `ship`, `batch`) |
| **MCP stdio handshake + probe** | `54 ms` | Instant local startup, zero remote network hops |
| **`pack` median (search + 4 files + `.env` block)** | `19.4 ms` | Gathers multi-file context faster than a single keystroke |
| **`batch` median (read-only outline across 40 files)** | `20.7 ms` | Inspects structure locally without flooding chat history |
| **`ship` median (2-file edit + `node` verify)** | `62.9 ms` | Snapshots, applies edits, verifies, or rewinds before stale state sticks |

---

## Why You Can Trust It on Real Projects

| Guardrail | Default Behavior | Why It Matters |
| :--- | :--- | :--- |
| **Secret Shield** | Redacts `.env`, `.env.*` (keeps `.env.example`), `*.pem`, `*.key`, `id_rsa`/`id_ed25519`, `.npmrc`, `.netrc`, `credentials.json` unless `allow_secrets: true` | Your AI never accidentally dumps live API keys into cloud context |
| **Workspace Jail** | Resolves symlinks via `fs.realpathSync` and blocks traversal or cross-drive paths outside your project folder | AI edits cannot wander outside your repo |
| **Read-Only `batch`** | Shell `exec`, filesystem writes, and `fetch` are disabled unless `TURNPACK_ALLOW_EXEC=1` | Programmatic inspection stays predictable without silent command execution |
| **Honest Rollback Status** | Reports `SHIPPED_AND_VERIFIED`, `FAILED_AND_ROLLED_BACK`, `FAILED_ROLLBACK_PARTIAL` (with file errors), or `FAILED_KEPT_ON_DISK` | You always know the exact state on disk if verification fails |
| **Zero Dependencies** | `"dependencies": {}` in `package.json`, strict TypeScript (`strict: true`, `noUncheckedIndexedAccess: true`), CI across Windows/macOS/Linux | Zero transitive dependency bloat and full Windows support without WSL |

See [SECURITY.md](SECURITY.md) for the complete threat model and optional `.turnpack.json` verify command allowlist.

---

## When You Don't Need Turnpack

- **One-line typo in a file you already have open:** Just use your editor or a single direct edit — there are no extra turns to collapse.
- **Whole-repo Markdown dumps for browser chat:** Use [Repomix](https://github.com/yamadashy/repomix) for full-repo snapshots. Turnpack focuses on task-scoped slices and test-gated local edits.

---

## Prior Art, Recipes & Links

Turnpack builds cleanly on ideas popularized by **Anthropic's Programmatic Tool Calling**, **Cloudflare Code Mode**, [`context-mode`](https://github.com/mksglu/context-mode), **Repomix**, and **Serena**, focusing on an ultra-small MIT-licensed 3-tool MCP server paired with test-gated preimage rollback.

- [Interactive Time Calculator & Setup Generator](docs/calculator.html)
- [Harness Compatibility Matrix](docs/harness-matrix.md)
- [Recipes (Multi-file Rename, Verify Allowlist, Native Windows, When Not to Use)](docs/recipes/01-multi-file-rename.md)
- [Benchmark Protocol & Local Runner](bench/README.md)
- [Security Policy](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md)

<div align="center">
  <sub>MIT License · Built by <a href="https://github.com/OnlyTerp">OnlyTerp</a></sub>
</div>
