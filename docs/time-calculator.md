# How Time-Saved Estimates Are Calculated

Turnpack never invents synthetic speedup percentages. Every time-saved chart and CLI estimate (`npx turnpack estimate` and [docs/calculator.html](calculator.html)) uses an explicit two-part latency formula matching what actually happens between AI tool calls:

```text
seconds_per_turn = ttft_seconds + (tokens_per_turn / tokens_per_second)
turns_saved_per_task = baseline_turns - turnpack_turns
minutes_saved_per_day = (prompts_per_day × turns_saved_per_task × seconds_per_turn) / 60
hours_saved_per_week = (minutes_saved_per_day × days_per_week) / 60
hours_saved_per_month = hours_saved_per_week × 4.3
```

## Why TTFT + Token Speed Compound

When an AI calls 16 small tools sequentially, you do not just wait for local disk I/O (~20ms) — you pay:
1. **Time to First Token (`TTFT`)**: queueing, prompt prefill, and reasoning startup freeze *before* the first character streams back.
2. **Thinking & Token Streaming (`tokens_per_turn ÷ tok/s`)**: generating thoughts and JSON arguments for each intermediate step.

## Reference Provider Profiles

| Profile (`--profile`) | TTFT / Call | Tokens / Intermediate Turn | Stream Speed | Total Wait / Turn | Weekly Saved (`20` medium tasks/d, `5d/wk`) |
| :--- | ---: | ---: | ---: | ---: | ---: |
| `fast` (Fast / Warm-Cache API) | 2s | 225 tok | 45 tok/s (`5s`) | `7s/turn` | `~2.3 hrs/wk` |
| `frontier` *(default)* (Frontier Reasoning) | 6s | 360 tok | 30 tok/s (`12s`) | `18s/turn` | `~6.0 hrs/wk` |
| `high-ttft` (High-TTFT / Busy Provider) | 15s | 400 tok | 20 tok/s (`20s`) | `35s/turn` | `~11.7 hrs/wk` |
| `local` (Slow-Prefill / Local 70B+ GPU) | 25s | 450 tok | 18 tok/s (`25s`) | `50s/turn` | `~16.7 hrs/wk` |

## Task Scope Profiles (`--size`)

| Profile | Normal Round-Trips | Turnpack Round-Trips | Typical Scope |
| :--- | ---: | ---: | :--- |
| `small` | 8 turns | 2 turns | 3–5 file tweak + test run |
| `medium` *(default)* | 16 turns | 4 turns | 6–10 file feature + verification |
| `large` | 28 turns | 7 turns | 15+ file cross-module refactor |

Customize for your exact provider anytime:

```bash
npx turnpack estimate --profile high-ttft
npx turnpack estimate --ttft 15 --tok-per-turn 400 --tps 20
```
