# How Time-Saved Estimates Are Calculated

Turnpack never invents synthetic speedup percentages. Every time-saved chart and CLI estimate (`npx turnpack estimate` and [docs/calculator.html](calculator.html)) uses simple, auditable arithmetic:

```text
turns_saved_per_task = baseline_turns - turnpack_turns
minutes_saved_per_day = (prompts_per_day × turns_saved_per_task × seconds_per_turn) / 60
hours_saved_per_week = (minutes_saved_per_day × days_per_week) / 60
hours_saved_per_month = hours_saved_per_week × 4.3
```

## Task Profiles Used in Default Charts

| Profile | Normal Round-Trips | Turnpack Round-Trips | Typical Scope |
| :--- | ---: | ---: | :--- |
| `small` | 8 turns | 2 turns | 3–5 file tweak + test run |
| `medium` *(default)* | 16 turns | 4 turns | 6–10 file feature + verification |
| `large` | 28 turns | 7 turns | 15+ file cross-module refactor |

These turn counts measure **saved AI thinking pauses** between multi-step searches, reads, and retries at a default 8s model latency per turn — they exclude additional wall-clock time saved when `ship` automatically rolls back a failing multi-file edit instead of forcing manual cleanup.

Customize for your own workflow anytime:

```bash
npx turnpack estimate --prompts 25 --size medium --turn-sec 8 --days 5
```
