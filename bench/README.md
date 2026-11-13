# Benchmarks

There are two different questions here, and they must not be mixed up.

## 1. How much overhead does Turnpack add? (measured)

```bash
npm run bench
```

runs `pack`, `batch` and `ship` five times each against a generated 42-file workspace and prints the median wall-clock time of each. No model is involved. These are the numbers quoted under "What Turnpack itself costs" in the README, together with the schema size and handshake time from `npx turnpack doctor --json`.

Reference run (Linux x64, Node 22.23, ripgrep 14.1):

| Operation | Median |
| :--- | ---: |
| `pack`: a regex search, four files, one blocked `.env` | about 8 ms |
| `batch`: outline 40 files | about 80 ms |
| `ship`: a two-file edit plus a `node` verify | about 35 ms |

`batch` is the slowest because each call starts a fresh, permission-restricted Node process. That start-up is the price of the isolation, and it is small next to a model turn.

## 2. Does an agent finish tasks faster with Turnpack? (one small measurement so far)

This needs a model in the loop:

```bash
npm run bench:agents -- --agents claude,codex --arms native,prompt,turnpack --runs 3
```

[`agent-bench.mjs`](agent-bench.mjs) runs one task through the agent CLIs you have installed: rename a function used in five files of a small generated project, then make the tests pass. Every run gets a fresh copy of the project in a scratch directory. Turnpack is handed to the CLI through a flag or a file inside that directory, and your global rules file and your other MCP servers are kept out of both arms (for Claude Code and Codex; OMP has no switch for that, so its numbers are not a clean comparison). Whether a run solved the task is checked by the script afterwards, not taken from the agent's word. Each run is a real session on your account and costs a few cents.

It reports, per arm: runs solved, time, model round trips (for Claude Code, one per answer from the model, however many tool calls that answer holds), tool calls, output tokens, cost where the CLI reports it, and how many runs actually called Turnpack. `--out <dir>` keeps the raw output of every run.

**First run** (2026-11-13, Windows 11, Claude Code 2.1.280 with Claude Sonnet 5, three runs per arm, medians; every run is in [`results/2026-11-13-claude-code.json`](results/2026-11-13-claude-code.json)):

| Arm | Solved | Model round trips | Tool calls | Time | Output tokens | Cost | Used Turnpack |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `native` | 3/3 | 6 | 13 | 23.4 s | 2,044 | $0.131 | - |
| `prompt` | 3/3 | 5 | 13 | 23.9 s | 2,063 | $0.121 | - |
| `turnpack` | 3/3 | 3 | 2 | 12.7 s | 873 | $0.084 | 3/3 |

Codex CLI 0.166.0 (default model, low reasoning effort), `turnpack` arm only: 3/3 solved, median 25.1 s, and all three runs used `pack`, then one `ship` carrying the five edits and `npm test`, then a `pack` to confirm. There is no Codex `native` arm: on that machine Codex's shell sandbox could not start processes in the scratch directory, so without Turnpack it could not run the tests at all, and a number from that would say nothing about Codex.

What this does and does not show:

- It is one task of one kind, small enough to finish in seconds. A rename is close to the best case for `ship`. Tasks with more thinking between steps will show a smaller share saved.
- Three runs per arm is enough to see that the result is stable (every `turnpack` run was the same three round trips) and not enough for a confidence interval.
- The `prompt` arm matched `native`, so the difference is the tools, not being told to batch.
- The time figures elsewhere in this repository are still a model with stated assumptions ([docs/time-calculator.md](../docs/time-calculator.md)).

The full protocol for a result worth publishing is below. The script covers its three arms and most of its report; the task set is the part that needs growing.

**Three arms, identical in everything else** (model, commit, permissions, time budget):

1. **Native.** The agent's built-in tools, with parallel reads and shell batching left on.
2. **Native plus prompt.** The same, with a short instruction to batch reads and edits. This separates what Turnpack's tools do from what merely asking the model to batch does.
3. **Native plus Turnpack.** The same agent with `pack`, `ship` and `batch` available.

**Report, in this order:**

1. Solve rate on tests the agent cannot see or edit. Failed runs stay in the denominator.
2. End-to-end time per task: median and range over at least three runs.
3. Model round trips and total tool calls.
4. Cost as reported by the provider.
5. Prompt-cache read ratio, where the provider reports it.

**And say what went wrong.** A run where the agent ignored the tools, or where arm 2 matched arm 3, is a result. Please open an issue with it.
