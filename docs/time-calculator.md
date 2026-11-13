# How the time estimates are calculated

The time figures from `npx turnpack estimate`, the [interactive calculator](calculator.html) and the chart in the README come from one formula. It is a model, not a benchmark: it turns assumptions you can see and change into a number. The measured comparison is separate: see "How much does it save?" in the README and [bench/README.md](../bench/README.md).

The number that matters most is `baseline_turns`, and it is easy to set too high. Current apps run independent tool calls in parallel ([baselines.md](baselines.md)), so a task with 13 tool calls can be 6 round trips, as it was in the measured run. Count round trips, not tool calls.

```text
seconds_per_turn     = ttft_seconds + (tokens_per_turn / tokens_per_second)
turns_saved_per_task = baseline_turns - turnpack_turns
minutes_saved_per_day = (tasks_per_day × turns_saved_per_task × seconds_per_turn) / 60
hours_saved_per_week  = (minutes_saved_per_day × days_per_week) / 60
hours_saved_per_month = hours_saved_per_week × 4.3
```

## Why a turn costs what it costs

Reading a file takes milliseconds. The turn around it does not. Each separate tool call makes the model produce a new response, and that has two parts:

1. **Time to first token.** The request is queued, the context is processed, and any thinking happens before output starts. On a local GPU with a warm cache this is often under a second. On a busy cloud API or with a cold cache it can be many seconds.
2. **Generation.** The model writes its reasoning and the tool call's arguments token by token, at whatever speed your provider or hardware delivers.

Fewer tool calls means fewer of both.

## The assumptions, and how far to trust them

**Latency profiles** (`--profile`). These are example values, chosen to span the range people report. They are not measurements of any named provider.

| Profile | Time to first token | Tokens per turn | Speed | One turn |
| :--- | ---: | ---: | ---: | ---: |
| `local` | 0.5s | 330 | 30 tok/s | 11.5s |
| `fast` | 2s | 225 | 45 tok/s | 7s |
| `frontier` (default) | 6s | 360 | 30 tok/s | 18s |
| `high-ttft` | 15s | 400 | 20 tok/s | 35s |
| `cold-cloud` | 25s | 450 | 18 tok/s | 50s |

**Turn counts** (`--size`). These are the weakest part of the model, so treat them as placeholders for your own observations.

| Size | Turns without | Turns with | Meant to represent |
| :--- | ---: | ---: | :--- |
| `small` | 8 | 2 | A 3–5 file tweak and a test run |
| `medium` (default) | 16 | 4 | A 6–10 file feature with verification |
| `large` | 28 | 7 | A refactor across 15 or more files |

The "without" column assumes an agent that makes one tool call per turn. Agents that issue several read or search calls in parallel start from a lower number, so the saving from `pack` is smaller for them. The "with" column assumes the agent actually uses `pack` and `ship` where it could, which depends on the model (see [steering.md](steering.md)).

What the model leaves out, in both directions:

- It does not count the turns an agent spends repairing a half-applied multi-file edit, which is what `ship` exists to prevent.
- It does not count the time your verify command takes. That time is spent either way.
- It counts waiting time only. Turnpack does not make the model think faster.

## Use your own numbers

Watch one ordinary task in your agent, count the round trips, and time a turn. Then:

```bash
npx turnpack estimate --ttft 2 --tok-per-turn 300 --tps 40 --size medium --prompts 15
```

```bash
npx turnpack estimate --turn-sec 9 --size small
```

`--json` prints the inputs and results for scripting.

## What would make this a measurement

A paired run: the same model, the same tasks and the same commit, with and without Turnpack, several times each. The protocol is in [bench/README.md](../bench/README.md). Results from anyone who runs it are welcome, including results that show no gain.
