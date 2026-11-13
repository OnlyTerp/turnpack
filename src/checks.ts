import fs from "node:fs";
import path from "node:path";
import { isRecord } from "./validate.js";

/**
 * A command that looks like this project's fast check, and where that was read from.
 *
 * `ship` is only as useful as its `verify`, and an agent that has to go looking for the test
 * command often skips it. So the server looks once, in the handful of places where projects
 * declare the command, and tells the model what it found. It is a hint read from the project's
 * own files, never something Turnpack runs on its own.
 */
export interface ProjectCheck {
  command: string;
  source: string;
}

function readText(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > 512 * 1024) return null;
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function exists(dir: string, name: string): boolean {
  return fs.existsSync(path.join(dir, name));
}

// A script that never exits (a watcher) or is npm's placeholder would only waste a turn.
const NOT_A_CHECK = /no test specified|--watch\b|\bwatch\b|\bnodemon\b|\bserve\b/i;
const TYPECHECK_SCRIPTS = ["typecheck", "type-check", "check-types", "types", "tsc", "check:types", "lint:types"];

function nodeChecks(root: string): ProjectCheck[] {
  const text = readText(path.join(root, "package.json"));
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const scripts = isRecord(parsed) && isRecord(parsed.scripts) ? parsed.scripts : {};
  const manager = exists(root, "pnpm-lock.yaml")
    ? "pnpm"
    : exists(root, "yarn.lock")
      ? "yarn"
      : exists(root, "bun.lock") || exists(root, "bun.lockb")
        ? "bun"
        : "npm";
  const usable = (name: string): boolean => {
    const body = scripts[name];
    return typeof body === "string" && body.trim() !== "" && !NOT_A_CHECK.test(body);
  };

  const found: ProjectCheck[] = [];
  const typecheck = TYPECHECK_SCRIPTS.find(usable);
  if (typecheck) found.push({ command: `${manager} run ${typecheck}`, source: "package.json" });
  if (usable("test")) {
    // `bun test` is Bun's own runner, not the script, so the script is always named explicitly there.
    found.push({ command: manager === "bun" ? "bun run test" : `${manager} test`, source: "package.json" });
  }
  return found;
}

function allowlistChecks(root: string): ProjectCheck[] | null {
  const text = readText(path.join(root, ".turnpack.json"));
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed) || parsed.enforceVerifyAllowlist !== true || !Array.isArray(parsed.allowedVerify)) return null;
    return parsed.allowedVerify
      .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
      .map((entry) => ({ command: entry.replace(/ \*$/, "").trim(), source: ".turnpack.json allowlist" }));
  } catch {
    return null;
  }
}

/** Up to `limit` likely check commands for the project at `root`, quickest kind first. */
export function detectChecks(root: string, limit = 2): ProjectCheck[] {
  // With an enforced allowlist, the list itself is the answer: nothing else would be allowed to run.
  const allowed = allowlistChecks(root);
  if (allowed) return allowed.slice(0, Math.max(limit, 4));

  const found: ProjectCheck[] = [...nodeChecks(root)];
  if (exists(root, "Cargo.toml")) found.push({ command: "cargo check", source: "Cargo.toml" });
  if (exists(root, "go.mod")) found.push({ command: "go test ./...", source: "go.mod" });
  const pyproject = readText(path.join(root, "pyproject.toml"));
  if (exists(root, "pytest.ini") || (pyproject && /\[tool\.pytest/.test(pyproject))) {
    found.push({ command: "pytest -q", source: exists(root, "pytest.ini") ? "pytest.ini" : "pyproject.toml" });
  }
  if (found.length === 0) {
    const makefile = readText(path.join(root, "Makefile"));
    if (makefile && /^test:/m.test(makefile)) found.push({ command: "make test", source: "Makefile" });
  }
  return found.slice(0, limit);
}

/** One line for a reply or the server instructions, or "" when nothing was found. */
export function describeChecks(checks: ProjectCheck[]): string {
  if (checks.length === 0) return "";
  const allowlisted = checks.every((check) => check.source === ".turnpack.json allowlist");
  const list = checks.map((check) => `\`${check.command}\``).join(", ");
  return allowlisted
    ? `This project only lets ship run: ${list}.`
    : `This project's check${checks.length > 1 ? "s" : ""}: ${list} (from ${[...new Set(checks.map((c) => c.source))].join(", ")}).`;
}
