export type ProjectSize = "small" | "medium" | "large";
export type ProviderProfile = "local" | "fast" | "frontier" | "high-ttft" | "cold-cloud";

export interface EstimateInput {
  promptsPerDay: number;
  size: ProjectSize;
  turnSeconds: number;
  daysPerWeek: number;
  ttftSeconds?: number;
  streamSeconds?: number;
  profileLabel?: string;
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

const PROVIDER_PROFILES: Record<
  ProviderProfile,
  { label: string; ttftSec: number; tokensPerTurn: number; tokensPerSec: number }
> = {
  local: { label: "Local GPU (Warm KV Cache, 0 Queue)", ttftSec: 0.5, tokensPerTurn: 330, tokensPerSec: 30 },
  fast: { label: "Fast Cloud API (Warm Cache)", ttftSec: 2, tokensPerTurn: 225, tokensPerSec: 45 },
  frontier: { label: "Frontier Cloud Reasoning", ttftSec: 6, tokensPerTurn: 360, tokensPerSec: 30 },
  "high-ttft": {
    label: "High-TTFT / Busy Cloud API",
    ttftSec: 15,
    tokensPerTurn: 400,
    tokensPerSec: 20,
  },
  "cold-cloud": {
    label: "Cold-Cache Cloud Router / Max Thinking",
    ttftSec: 25,
    tokensPerTurn: 450,
    tokensPerSec: 18,
  },
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
  let explicitTurnSeconds: number | undefined;
  let daysPerWeek = 5;
  let providerProfile: ProviderProfile = "frontier";
  let ttftOverride: number | undefined;
  let tokPerTurnOverride: number | undefined;
  let tpsOverride: number | undefined;
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
      explicitTurnSeconds = Math.max(1, Math.min(180, Number(next) || 8));
      i += 1;
    } else if (arg === "--days" && next) {
      daysPerWeek = Math.max(1, Math.min(7, Number(next) || 5));
      i += 1;
    } else if (
      arg === "--profile" &&
      (next === "local" ||
        next === "fast" ||
        next === "frontier" ||
        next === "high-ttft" ||
        next === "cold-cloud")
    ) {
      providerProfile = next;
      i += 1;
    } else if (arg === "--ttft" && next) {
      const parsed = Number(next);
      ttftOverride = Math.max(0.1, Math.min(120, Number.isFinite(parsed) && parsed > 0 ? parsed : 6));
      i += 1;
    } else if (arg === "--tok-per-turn" && next) {
      tokPerTurnOverride = Math.max(40, Math.min(4000, Number(next) || 360));
      i += 1;
    } else if (arg === "--tps" && next) {
      tpsOverride = Math.max(1, Math.min(500, Number(next) || 30));
      i += 1;
    } else if (arg === "--json") {
      asJson = true;
    }
  }

  let turnSeconds: number;
  let ttftSeconds: number | undefined;
  let streamSeconds: number | undefined;
  let profileLabel: string;

  if (explicitTurnSeconds !== undefined) {
    turnSeconds = explicitTurnSeconds;
    profileLabel = "Custom per-turn pause";
  } else if (
    ttftOverride !== undefined ||
    tokPerTurnOverride !== undefined ||
    tpsOverride !== undefined
  ) {
    ttftSeconds = Number((ttftOverride ?? 6).toFixed(1));
    const tokPerTurn = tokPerTurnOverride ?? 360;
    const tps = tpsOverride ?? 30;
    streamSeconds = Number((tokPerTurn / tps).toFixed(1));
    turnSeconds = Number((ttftSeconds + streamSeconds).toFixed(1));
    profileLabel = `Custom TTFT (${ttftSeconds}s) + Stream (${tokPerTurn} tok @ ${tps} tok/s)`;
  } else {
    const p = PROVIDER_PROFILES[providerProfile];
    ttftSeconds = p.ttftSec;
    streamSeconds = Number((p.tokensPerTurn / p.tokensPerSec).toFixed(1));
    turnSeconds = Number((ttftSeconds + streamSeconds).toFixed(1));
    profileLabel = p.label;
  }

  const res = calculateEstimate({
    promptsPerDay,
    size,
    turnSeconds,
    daysPerWeek,
    ...(ttftSeconds !== undefined ? { ttftSeconds } : {}),
    ...(streamSeconds !== undefined ? { streamSeconds } : {}),
    profileLabel,
  });

  if (asJson) {
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return res;
  }

  const sizeInfo = SIZE_PROFILES[size];
  const baseMinDay = Number(
    ((promptsPerDay * res.baselineTurnsPerTask * turnSeconds) / 60).toFixed(1),
  );
  const tpMinDay = Number(
    ((promptsPerDay * res.turnpackTurnsPerTask * turnSeconds) / 60).toFixed(1),
  );

  process.stdout.write("\nturnpack time-saved estimator (TTFT + token-streaming round-trip math)\n");
  process.stdout.write("──────────────────────────────────────────────────────────────────────────────\n");
  process.stdout.write(
    `  Workload : ${promptsPerDay} tasks/day · ${sizeInfo.label} · ${daysPerWeek}d/wk\n` +
      `  Provider : ${profileLabel}\n`,
  );
  if (ttftSeconds !== undefined && streamSeconds !== undefined) {
    process.stdout.write(
      `  1 Turn   : ${ttftSeconds}s TTFT + ${streamSeconds}s token stream = ${turnSeconds}s/turn\n\n`,
    );
  } else {
    process.stdout.write(`  1 Turn   : ${turnSeconds}s per round-trip\n\n`);
  }

  process.stdout.write(
    `  Normal loop  [${renderBar(res.baselineTurnsPerTask, res.baselineTurnsPerTask)}]  ${res.baselineTurnsPerTask} turns/task  (~${baseMinDay} min/day wait)\n`,
  );
  process.stdout.write(
    `  Turnpack     [${renderBar(res.turnpackTurnsPerTask, res.baselineTurnsPerTask)}]   ${res.turnpackTurnsPerTask} turns/task  (~${tpMinDay} min/day wait)\n\n`,
  );
  process.stdout.write(
    `  Estimated waiting time saved:\n` +
      `    - Per task : ${res.turnsSavedPerTask} fewer AI turns (~${Math.round(res.turnsSavedPerTask * turnSeconds)}s)\n` +
      `    - Per day  : ~${res.minutesSavedPerDay} minutes saved\n` +
      `    - Per week : ~${res.hoursSavedPerWeek} hours saved\n` +
      `    - Per month: ~${res.hoursSavedPerMonth} hours saved\n\n`,
  );

  process.stdout.write("  Across provider speeds (for your selected workload):\n");
  for (const key of ["local", "fast", "frontier", "high-ttft", "cold-cloud"] as const) {
    const p = PROVIDER_PROFILES[key];
    const pStream = Number((p.tokensPerTurn / p.tokensPerSec).toFixed(1));
    const pSec = Number((p.ttftSec + pStream).toFixed(1));
    const cmp = calculateEstimate({ promptsPerDay, size, turnSeconds: pSec, daysPerWeek });
    process.stdout.write(
      `    - ${p.label.padEnd(44)} ${String(p.ttftSec).padStart(4)}s TTFT + ${String(pStream).padStart(4)}s gen = ${String(pSec).padStart(4)}s/turn -> ~${cmp.hoursSavedPerWeek} hrs/wk\n`,
    );
  }
  process.stdout.write("──────────────────────────────────────────────────────────────────────────────\n");
  process.stdout.write(
    "  Note: Illustrative latency math (excludes extra time saved avoiding broken half-edits).\n\n",
  );
  return res;
}
