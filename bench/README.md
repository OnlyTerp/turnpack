# Turnpack Benchmark & Local Speed Suite

Turnpack reports two strictly separated measurements:

1. **Local Engine Latency (`bench/run-local-bench.mjs`)** — Deterministic millisecond timings for `pack`, `ship`, and read-only `batch` on a 40-file local workspace fixture. Zero external LLM calls required.
2. **Paired 3-Arm LLM Benchmark (External Eval Protocol)** — Whenever publishing full LLM coding benchmarks, we require all 3 arms under identical model, commit SHA, permissions, and timeout budget:
   - **Arm 1 — Native Harness:** Built-in search, parallel reads, and shell batching enabled.
   - **Arm 2 — Native + Prompt Control:** Same concise batching guidance without Turnpack MCP tools.
   - **Arm 3 — Native + Turnpack (`v0.1`):** Identical harness with `pack`, `ship`, and read-only `batch`.

## Mandatory Reported Metrics (Priority Order)

1. **`pass@1` Solve Rate** on immutable external tests (failed runs stay in denominator).
2. **End-to-End Elapsed Time** (median + min–max spread across `>= 3` independent runs/task).
3. **Model Round Trips** & total tool calls.
4. **Provider-Reported Cost ($)** (no synthetic credit estimates).
5. **Prompt Cache Read Ratio (%)** (`cache_read_input_tokens / total_input_tokens`, marked `not available` if omitted by provider).

Run the local engine benchmark anytime with:

```bash
node bench/run-local-bench.mjs
```
