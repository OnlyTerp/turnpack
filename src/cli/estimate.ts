export type ProjectSize = "small" | "medium" | "large";

export interface EstimateInput {
  promptsPerDay: number;
  size: ProjectSize;
  turnSeconds: number;
  daysPerWeek: number;
}

export interface EstimateResult {
  input: EstimateInput;
  baselineTurnsPerTask: number;
  turnpackTurnsPerTask: number;
  turnsSavedPerTask: number;
  minutesSavedPerDay: number;
  hoursSavedPerWeek: number;
  hoursSavedPerMonth: number;
}

const SIZE_PROFILES: Record<ProjectSize, { baseline: number; turnpack: number; label: string }> = {
  small: { baseline: 8, turnpack: 2, label: "Small 3–5 file tweak" },
  medium: { baseline: 16, turnpack: 4, label: "Typical 6–10 file feature" },
  large: { baseline: 28, turnpack: 7, label: "Multi-module refactor" },
};

export function calculateEstimate(input: EstimateInput): EstimateResult {
  const profile = SIZE_PROFILES[input.size];
  const turnsSavedPerTask = Math.max(0, profile.baseline - profile.turnpack);
  const secondsSavedPerDay = input.promptsPerDay * turnsSavedPerTask * input.turnSeconds;
  const minutesSavedPerDay = Number((secondsSavedPerDay / 60).toFixed(1));
  const hoursSavedPerWeek = Number(((secondsSavedPerDay * input.daysPerWeek) / 3600).toFixed(1));
  const hoursSavedPerMonth = Number((hoursSavedPerWeek * 4.3).toFixed(1));

  return {
    input,
    baselineTurnsPerTask: profile.baseline,
    turnpackTurnsPerTask: profile.turnpack,
    turnsSavedPerTask,
    minutesSavedPerDay,
    hoursSavedPerWeek,
    hoursSavedPerMonth,
  };
}

function renderBar(filled: number, total: number, width = 28): string {
  const ratio = Math.max(0, Math.min(1, filled / Math.max(1, total)));
  const count = Math.round(ratio * width);
  return `${"#".repeat(count)}${".".repeat(width - count)}`;
}

export function runEstimate(argv: string[]): EstimateResult {
  let promptsPerDay = 20;
  let size: ProjectSize = "medium";
  let turnSeconds = 8;
  let daysPerWeek = 5;
  let asJson = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--prompts" && next) {
      promptsPerDay = Math.max(1, Math.min(200, Number(next) || 20));
      i += 1;
    } else if (arg === "--size" && (next === "small" || next === "medium" || next === "large")) {
      size = next;
      i += 1;
    } else if (arg === "--turn-sec" && next) {
      turnSeconds = Math.max(1, Math.min(60, Number(next) || 8));
      i += 1;
    } else if (arg === "--days" && next) {
      daysPerWeek = Math.max(1, Math.min(7, Number(next) || 5));
      i += 1;
    } else if (arg === "--json") {
      asJson = true;
    }
  }

  const res = calculateEstimate({ promptsPerDay, size, turnSeconds, daysPerWeek });
  if (asJson) {
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return res;
  }

  const profile = SIZE_PROFILES[size];
  const baseMinDay = Number(
    ((promptsPerDay * res.baselineTurnsPerTask * turnSeconds) / 60).toFixed(1),
  );
  const tpMinDay = Number(
    ((promptsPerDay * res.turnpackTurnsPerTask * turnSeconds) / 60).toFixed(1),
  );

  process.stdout.write("\nturnpack time-saved estimator (transparent round-trip math)\n");
  process.stdout.write("──────────────────────────────────────────────────────────────────────\n");
  process.stdout.write(
    `  Workload: ${promptsPerDay} tasks/day · ${profile.label} · ${turnSeconds}s AI thinking pause/turn · ${daysPerWeek}d/wk\n\n`,
  );
  process.stdout.write(
    `  Normal loop  [${renderBar(res.baselineTurnsPerTask, res.baselineTurnsPerTask)}]  ${res.baselineTurnsPerTask} turns/task  (~${baseMinDay} min/day wait)\n`,
  );
  process.stdout.write(
    `  Turnpack     [${renderBar(res.turnpackTurnsPerTask, res.baselineTurnsPerTask)}]   ${res.turnpackTurnsPerTask} turns/task  (~${tpMinDay} min/day wait)\n\n`,
  );
  process.stdout.write(
    `  Estimated waiting time saved:\n` +
      `    - Per task : ${res.turnsSavedPerTask} fewer AI turns (~${res.turnsSavedPerTask * turnSeconds}s)\n` +
      `    - Per day  : ~${res.minutesSavedPerDay} minutes saved\n` +
      `    - Per week : ~${res.hoursSavedPerWeek} hours saved\n` +
      `    - Per month: ~${res.hoursSavedPerMonth} hours saved\n`,
  );
  process.stdout.write("──────────────────────────────────────────────────────────────────────\n");
  process.stdout.write(
    "  Note: Illustrative round-trip wait math (excludes time saved avoiding broken half-edits).\n\n",
  );
  return res;
}
