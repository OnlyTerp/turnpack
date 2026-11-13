import fs from "node:fs";

function readPackageVersion(): string {
  try {
    const raw = fs.readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version) {
      return parsed.version;
    }
  } catch {
    // Fall through: a missing or unreadable package.json must never stop the server.
  }
  return "0.0.0";
}

/** Single source of truth for the version: package.json, read once at startup. */
export const VERSION: string = readPackageVersion();
