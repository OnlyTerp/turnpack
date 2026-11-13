#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

const SKIP_SCAN_DIRS = new Set([".git", "node_modules", "dist", "assets"]);
const BINARY_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".woff", ".woff2"]);

const j = (...parts) => parts.join("");

// Construct sensitive tokens dynamically so this scanner never triggers on its own source.
const SENSITIVE_RULES = [
  { name: "Windows profile dir", regex: new RegExp([j("C", ":"), j("Use", "rs")].join("[\\\\/]"), "i") },
  { name: "Non-portable drive path", regex: new RegExp(`(?:^|[^A-Za-z0-9_])(${j("T", "|", "U")}):[\\\\/]`, "i") },
  { name: "Unix personal home", regex: new RegExp(j("/ho", "me/", "te", "rp"), "i") },
  { name: "Private host alias", regex: new RegExp(j("\\b", "ai", "pc\\b"), "i") },
  {
    name: "Private bridge or domain",
    regex: new RegExp(
      [j("type", "safe"), j("jev", "Judge"), j("t", "er", "pbot"), j("t", "er", "p-hq")].join("|"),
      "i",
    ),
  },
  {
    name: "Vendor or credential helper",
    regex: new RegExp(
      [
        j("find", "Devin", "Token"),
        j("sw", "e-grep"),
        j("swe", "grep"),
        j("cod", "eium"),
        j("readOmp", "Credential"),
        j("cer", "ebras"),
      ].join("|"),
      "i",
    ),
  },
  {
    name: "Internal workspace ref",
    regex: new RegExp(
      [j("ClaudeCode", "Blueprint"), j("claude-code", "-source-leak"), j("anti", "gravity/brain")].join("|"),
      "i",
    ),
  },
  {
    name: "Internal benchmark codename",
    regex: new RegExp(
      [
        j("Car", "bon\\s+1M"),
        j("Spe", "ed\\s+v\\d"),
        j("Hyp", "er-Swarm"),
        j("Om", "ni-Recon"),
        j("Me", "ga-Turn"),
        j("Tu", "rn-Zero"),
      ].join("|"),
      "i",
    ),
  },
];

const SRC_QUALITY_RULES = [
  { name: "TypeScript explicit any", regex: /:\s*any\b|\bas\s+any\b/ },
  { name: "Unresolved marker", regex: new RegExp(`\\b(?:${j("TO", "DO")}|${j("FIX", "ME")})\\b`) },
];

const failures = [];

function checkTextContent(label, text, { isSourceTs = false } = {}) {
  for (const rule of SENSITIVE_RULES) {
    if (rule.regex.test(text)) {
      failures.push(`${label}: matched forbidden pattern [${rule.name}]`);
    }
  }

  // Word-boundary personal handle check outside approved OnlyTerp brand attribution.
  const withoutBrand = text.replace(new RegExp(j("Only", "T", "erp"), "gi"), "");
  const handleWord = new RegExp(`\\b${j("t", "e", "r", "p")}\\b`, "i");
  if (handleWord.test(withoutBrand)) {
    failures.push(`${label}: matched standalone personal word outside brand credit`);
  }

  if (isSourceTs) {
    for (const q of SRC_QUALITY_RULES) {
      if (q.regex.test(text)) {
        failures.push(`${label}: code quality violation [${q.name}]`);
      }
    }
  }
}

function walkAndCheck(rootDir, currentDir = rootDir) {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_SCAN_DIRS.has(entry.name)) continue;
    const abs = path.join(currentDir, entry.name);
    const rel = path.relative(rootDir, abs).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      walkAndCheck(rootDir, abs);
      continue;
    }

    const lower = entry.name.toLowerCase();
    if (
      (lower === ".env" || (lower.startsWith(".env.") && lower !== ".env.example")) ||
      lower.endsWith(".pem") ||
      lower.endsWith(".key")
    ) {
      failures.push(`${rel}: forbidden secret file committed/staged`);
      continue;
    }

    if (BINARY_EXTS.has(path.extname(lower))) continue;
    const text = fs.readFileSync(abs, "utf8");
    checkTextContent(rel, text, {
      isSourceTs: rel.startsWith("src/") && rel.endsWith(".ts"),
    });
  }
}

// 1. Working tree check
walkAndCheck(repoRoot);

// 2. Git history author/email check if commits exist
try {
  const log = execFileSync("git", ["log", "--format=%an|%ae|%cn|%ce"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  for (const line of log.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (!line.includes(j("Only", "T", "erp")) || !line.includes("users.noreply.github.com")) {
      failures.push(`git log identity not sanitized: ${line}`);
    }
  }
} catch {
  // Repo may have zero commits before initial commit.
}

// 3. npm pack tarball check inside isolated temp dir
const stageBase = process.env.TURNPACK_STAGE_DIR || os.tmpdir();
fs.mkdirSync(stageBase, { recursive: true });
const packStage = fs.mkdtempSync(path.join(stageBase, "turnpack-packcheck-"));
try {
  const packed =
    process.platform === "win32"
      ? execFileSync("cmd.exe", ["/d", "/s", "/c", "npm", "pack", "--pack-destination", packStage, "--json"], {
          cwd: repoRoot,
          encoding: "utf8",
          windowsHide: true,
        })
      : execFileSync("npm", ["pack", "--pack-destination", packStage, "--json"], {
          cwd: repoRoot,
          encoding: "utf8",
        });
  const parsed = JSON.parse(packed);
  const tgzName = parsed[0]?.filename;
  if (!tgzName) {
    failures.push("npm pack produced no tarball filename");
  } else {
    const extractDir = path.join(packStage, "extracted");
    fs.mkdirSync(extractDir, { recursive: true });
    execFileSync("tar", ["-xzf", path.join(packStage, tgzName), "-C", extractDir]);
    walkAndCheck(path.join(extractDir, "package"));
  }
} finally {
  fs.rmSync(packStage, { recursive: true, force: true });
}

if (failures.length > 0) {
  process.stderr.write(`LEAK_CHECK_FAILED (${failures.length} issue(s)):\n`);
  for (const f of failures) {
    process.stderr.write(`  - ${f}\n`);
  }
  process.exit(1);
}

process.stdout.write("LEAK_CHECK_PASSED\n");
