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

## 2. Does an agent finish tasks faster with Turnpack? (not yet measured)

This needs a model in the loop, and nobody has published a run yet. The time figures elsewhere in this repository are a model with stated assumptions ([docs/time-calculator.md](../docs/time-calculator.md)), not results.

When someone runs it, this is the protocol that makes the result worth reading.

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
