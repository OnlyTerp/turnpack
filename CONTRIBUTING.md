# Contributing to Turnpack

Contributions are welcome! We love clean engineering PRs, new harness adapters, benchmark reproductions, and clearer docs for everyday AI builders.

## Development Workflow

```bash
git clone https://github.com/OnlyTerp/turnpack.git
cd turnpack
npm install
npm test
npm run check:leak
```

## Code Quality Rules

- Keep `"dependencies": {}` (zero runtime dependencies).
- Strict TypeScript (`strict: true`, `noUncheckedIndexedAccess: true`, zero `: any` / `as any`).
- All tests run with built-in `node:test` (`npm test`) across Windows, macOS, and Linux.
- Never commit personal paths, secrets, `.env` files, or synthetic benchmark claims. `npm run check:leak` validates both the working tree and the built `npm pack` tarball.

## Adding a Harness Adapter

Want Turnpack auto-setup hooks/extensions for **Cursor**, **Gemini CLI**, **OpenCode**, **Grok CLI**, or another coding agent?
Open an issue using the **Harness Adapter** template or submit a PR adding tests under `test/mcp-cli.test.mjs` proving idempotent `init` and `uninstall`.
