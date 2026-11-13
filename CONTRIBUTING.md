# Contributing to Turnpack

Contributions are welcome: bug fixes, adapters for more AI apps, benchmark runs, and clearer docs.

## Getting started

```bash
git clone https://github.com/OnlyTerp/turnpack.git
cd turnpack
npm install
npm test
```

`npm install` builds `dist/`. `npm test` rebuilds and runs the suite with Node's built-in test runner. Before opening a pull request, run everything CI runs:

```bash
npm run verify
```

```bash
node dist/cli.js demo && node dist/cli.js doctor
```

## Ground rules

- **No runtime dependencies.** `"dependencies": {}` stays empty. Dev dependencies are TypeScript and Node's types.
- **Strict TypeScript.** `strict` and `noUncheckedIndexedAccess` are on; no `any`.
- **Tests for behaviour, attack tests for fences.** A fix comes with a test that fails without it. A change to anything in [SECURITY.md](SECURITY.md) comes with a test that tries to get through it.
- **Claims match output.** A number in the README or docs must come from a command a reader can run. Modeled numbers are labeled as modeled.
- **The tool schema is a budget.** Everything in `tools/list` is paid for in every session of every user. Keep descriptions short and add arguments reluctantly; `doctor` fails above 1,500 tokens.
- **Cross-platform.** CI runs Linux, macOS and Windows. Use `node:path`, avoid shell-specific syntax in tests, and guard anything POSIX-only.

## Layout

| Path | What lives there |
| :--- | :--- |
| `src/tools/` | `pack`, `ship`, `batch` and the isolated `batch` runner |
| `src/security.ts`, `src/roots.ts` | Path confinement, secret patterns, workspace root policy |
| `src/mcp-server.ts` | The stdio JSON-RPC server and the tool schema |
| `src/cli/` | `demo`, `doctor`, `init`/`uninstall`, `estimate`, `audit` |
| `test/` | `node:test` suites; `helpers.mjs` has a small MCP client |
| `scripts/` | The leak gate and the asset generator |

## The leak gate

`npm run check:leak` scans the working tree and the packed tarball for personal paths, secrets and leftover markers, and checks that the tarball contains everything the CLI needs. It also checks that commits made under the project's own name use a GitHub noreply address. Your commits can use whatever identity you normally use.

## Adding an AI app

Open an issue with the **Harness Adapter** template, or send a pull request that adds the target to `src/cli/installer.ts` and `src/cli/audit.ts`, a row to [docs/harness-matrix.md](docs/harness-matrix.md), and a test in `test/mcp-cli.test.mjs` showing that `init` and `uninstall` are idempotent and leave sibling entries alone.

## Regenerating the visuals

```bash
npm run build && python3 scripts/render-assets.py
```

needs Pillow and ffmpeg. The demo GIF is drawn from the real output of `turnpack demo` and `turnpack doctor`, so regenerate it when either changes. The measured chart, the numbers in the hero and the headings of the how-it-works diagram are read from `bench/results/`, and `test/docs.test.mjs` fails if the README or an image quotes a number those runs do not show.

`assets/social-preview.png` is the 1280×640 card shown when the repository is linked somewhere. It is a rasterized copy of `assets/social-preview.svg` (open the SVG in a browser and screenshot it at that size); GitHub takes the PNG under Settings → Social preview.

## Releasing (maintainers)

```bash
npm version patch
```

```bash
git push --follow-tags
```

The `Release` workflow checks that the tag matches `package.json`, runs the full gate, and publishes to npm with provenance. It needs an npm automation token in the `NPM_TOKEN` repository secret.
