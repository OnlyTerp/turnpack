import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

// The README and its images quote numbers from a benchmark. This test recomputes those numbers
// from the recorded runs, so a figure cannot be edited in one place and left stale in another.
const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

describe("published numbers", () => {
  const recorded = JSON.parse(read("bench/results/2026-11-13-claude-code.json"));
  const arm = (name) => {
    const runs = recorded.runs.filter((run) => run.arm === name);
    const of = (key) => median(runs.map((run) => run[key]));
    return {
      solved: `${runs.filter((run) => run.solved).length}/${runs.length}`,
      roundTrips: String(of("roundTrips")),
      toolCalls: String(of("toolCalls")),
      seconds: `${of("seconds").toFixed(1)} s`,
      outputTokens: of("outputTokens").toLocaleString("en-US"),
      cost: `$${of("costUsd").toFixed(3)}`,
      usedTurnpack: runs.filter((run) => run.turnpackCalls.length > 0).length,
      raw: { seconds: of("seconds"), cost: of("costUsd"), tokens: of("outputTokens"), trips: of("roundTrips") },
    };
  };
  const native = arm("native");
  const asked = arm("prompt");
  const turnpack = arm("turnpack");
  const row = (a) => `| ${a.solved} | ${a.roundTrips} | ${a.toolCalls} | ${a.seconds} | ${a.outputTokens} | ${a.cost} |`;

  it("the README table is the median of the recorded runs", () => {
    const readme = read("README.md");
    assert.ok(readme.includes(`| Built-in tools ${row(native)}`), row(native));
    assert.ok(readme.includes(`| Built-in tools, asked to batch ${row(asked)}`), row(asked));
    assert.ok(readme.includes(`| With Turnpack ${row(turnpack)}`), row(turnpack));
    assert.equal(turnpack.usedTurnpack, 3);
    // The badge and the image descriptions repeat the headline figures.
    assert.ok(readme.includes(`measured-${native.roundTrips}%20%E2%86%92%20${turnpack.roundTrips}%20round%20trips`));
    for (const figure of [native.seconds.replace(" s", " seconds"), turnpack.cost, native.cost, turnpack.outputTokens]) {
      assert.ok(readme.includes(figure), figure);
    }
  });

  it("the benchmark notes and the baseline page quote the same medians", () => {
    for (const file of ["bench/README.md", "docs/baselines.md"]) {
      const text = read(file);
      for (const a of [native, asked, turnpack]) {
        assert.ok(text.includes(`| ${a.roundTrips} | ${a.toolCalls} | ${a.seconds} | ${a.outputTokens} |`), `${file}: ${a.seconds}`);
      }
    }
  });

  it("the images are drawn from the same runs", () => {
    const percent = (before, after) => `−${Math.round((1 - after / before) * 100)}%`;
    for (const theme of ["dark", "light"]) {
      const chart = read(`assets/measured-${theme}.svg`);
      for (const text of [
        native.seconds,
        turnpack.seconds,
        native.cost,
        turnpack.cost,
        native.outputTokens,
        turnpack.outputTokens,
        percent(native.raw.trips, turnpack.raw.trips),
        percent(native.raw.seconds, turnpack.raw.seconds),
        percent(native.raw.tokens, turnpack.raw.tokens),
        percent(native.raw.cost, turnpack.raw.cost),
        `${recorded.app} ${recorded.appVersion} with ${recorded.model}`,
      ]) {
        assert.ok(chart.includes(`>${text}<`) || chart.includes(text), `measured-${theme}.svg: ${text}`);
      }
      const hero = read(`assets/hero-${theme}.svg`);
      assert.ok(hero.includes(native.cost) && hero.includes(turnpack.cost) && hero.includes(turnpack.seconds));
      const how = read(`assets/how-it-works-${theme}.svg`);
      assert.ok(how.includes(`${native.roundTrips} round trips · ${native.toolCalls} tool calls · ${native.seconds}`));
      assert.ok(how.includes(`${turnpack.roundTrips} round trips · ${turnpack.toolCalls} tool calls · ${turnpack.seconds}`));
    }
  });

  it("every image the README shows exists", () => {
    const readme = read("README.md");
    const shown = [...readme.matchAll(/(?:src|srcset)="(assets\/[^"]+)"/g)].map((match) => match[1]);
    assert.ok(shown.length >= 8);
    for (const rel of shown) assert.ok(fs.existsSync(path.join(ROOT, rel)), rel);
  });
});
