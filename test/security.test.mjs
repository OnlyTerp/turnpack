import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  getShardCacheDir,
  isSecretPath,
  resolveSafePath,
  writePrivateShard,
} from "../dist/security.js";

describe("security & confinement", () => {
  let tmpRoot;
  let repoDir;
  let outsideDir;
  let prevCacheOverride;

  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "turnpack-sec-"));
    repoDir = path.join(tmpRoot, "repo");
    outsideDir = path.join(tmpRoot, "outside");
    fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(repoDir, "src", "ok.ts"), "export const ok = 1;\n");
    fs.writeFileSync(path.join(outsideDir, "secret.txt"), "top-secret\n");
    prevCacheOverride = process.env.TURNPACK_CACHE_DIR;
    process.env.TURNPACK_CACHE_DIR = path.join(tmpRoot, "cache-shards");
  });

  after(() => {
    if (prevCacheOverride === undefined) {
      delete process.env.TURNPACK_CACHE_DIR;
    } else {
      process.env.TURNPACK_CACHE_DIR = prevCacheOverride;
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("allows workspace files including dot-prefixed filenames starting with ..", () => {
    const inside = resolveSafePath(repoDir, "src/ok.ts");
    assert.equal(inside.relPath, "src/ok.ts");

    const dotdotName = resolveSafePath(repoDir, "..valid-name.txt");
    assert.equal(dotdotName.relPath, "..valid-name.txt");
  });

  it("blocks parent traversal and external paths outside workspace", () => {
    assert.throws(() => resolveSafePath(repoDir, "../outside/secret.txt"), /ERR_PATH_OUTSIDE_WORKSPACE/);
    assert.throws(() => resolveSafePath(repoDir, outsideDir), /ERR_PATH_OUTSIDE_WORKSPACE/);
    if (process.platform === "win32") {
      const otherDrive = repoDir[0]?.toUpperCase() === "C" ? "Z:\\nope.txt" : "C:\\Windows\\System32\\drivers\\etc\\hosts";
      assert.throws(() => resolveSafePath(repoDir, otherDrive), /ERR_PATH_OUTSIDE_WORKSPACE/);
    }
  });

  it("blocks symlink escape even for not-yet-created nested files", () => {
    const linkPath = path.join(repoDir, "escape-link");
    try {
      fs.symlinkSync(outsideDir, linkPath, "dir");
    } catch (err) {
      if (err && (err.code === "EPERM" || err.code === "EACCES")) {
        return;
      }
      throw err;
    }
    assert.throws(
      () => resolveSafePath(repoDir, "escape-link/new-nested/file.txt"),
      /ERR_PATH_OUTSIDE_WORKSPACE/,
    );
  });

  it("classifies secret paths accurately while allowing safe examples and .pub keys", () => {
    assert.equal(isSecretPath(".env"), true);
    assert.equal(isSecretPath("apps/api/.env.production"), true);
    assert.equal(isSecretPath("certs/private.pem"), true);
    assert.equal(isSecretPath("keys/deploy.key"), true);
    assert.equal(isSecretPath(".ssh/id_ed25519"), true);
    assert.equal(isSecretPath(".aws/credentials"), true);
    assert.equal(isSecretPath("service-account-prod.json"), true);

    assert.equal(isSecretPath(".env.example"), false);
    assert.equal(isSecretPath("config/.env.template"), false);
    assert.equal(isSecretPath(".ssh/id_ed25519.pub"), false);
    assert.equal(isSecretPath("src/auth/env.ts"), false);
  });

  it("writes private shards outside the workspace cache dir and respects cache dir isolation", () => {
    const shard = writePrivateShard("unit", "hello shard");
    assert.equal(shard.startsWith(getShardCacheDir()), true);
    assert.equal(shard.startsWith(repoDir), false);
    assert.equal(fs.readFileSync(shard, "utf8"), "hello shard");
  });
});
