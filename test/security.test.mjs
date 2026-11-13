import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { runPack } from "../dist/index.js";
import { applyClientRoots, configScope, createRootPolicy, isBroadDirectory, resolveToolRoot } from "../dist/roots.js";
import { removeDir, trySymlink } from "./helpers.mjs";
import {
  findShortNameAlias,
  getShardCacheDir,
  isInsideDir,
  isProtectedPath,
  isSecretPath,
  resolveSafePath,
  windowsPathProblem,
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
    return removeDir(tmpRoot);
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

  it("follows a dangling symlink to where a write would land", () => {
    // exists() says a dangling link is "not there", which once let it pass for a plain new name.
    if (!trySymlink(path.join(outsideDir, "not-yet.txt"), path.join(repoDir, "dangling-out.txt"))) return;
    assert.throws(() => resolveSafePath(repoDir, "dangling-out.txt"), /ERR_PATH_OUTSIDE_WORKSPACE/);

    trySymlink(path.join(outsideDir, "missing-dir"), path.join(repoDir, "dangling-dir"), "dir");
    assert.throws(() => resolveSafePath(repoDir, "dangling-dir/new/file.txt"), /ERR_PATH_OUTSIDE_WORKSPACE/);

    // A chain of links is followed to its end.
    trySymlink("dangling-out.txt", path.join(repoDir, "hop.txt"));
    assert.throws(() => resolveSafePath(repoDir, "hop.txt"), /ERR_PATH_OUTSIDE_WORKSPACE/);

    // A link that stays inside resolves to its target, so checks apply to the real destination.
    trySymlink(path.join("src", "created-later.ts"), path.join(repoDir, "alias.ts"));
    assert.equal(resolveSafePath(repoDir, "alias.ts").relPath, "src/created-later.ts");

    // Links that point at each other end in an error, not a hang.
    trySymlink("loop-b", path.join(repoDir, "loop-a"));
    trySymlink("loop-a", path.join(repoDir, "loop-b"));
    assert.throws(() => resolveSafePath(repoDir, "loop-a"), /too many symbolic links/);
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

    for (const secret of [
      ".envrc",
      "deploy/production.env",
      "infra/terraform.tfstate",
      "infra/prod.tfvars",
      "android/release.keystore",
      "home/.kube/config",
      "home/.docker/config.json",
      ".git/config",
      "config/secrets.yaml",
      ".pgpass",
      "ops/putty.ppk",
    ]) {
      assert.equal(isSecretPath(secret), true, secret);
    }
    for (const plain of ["example.env", "docs/config.json", "src/config.ts", "kube/config.md", "environment.ts"]) {
      assert.equal(isSecretPath(plain), false, plain);
    }

    // A caller that names the parent directory as its root must not turn
    // ".aws/credentials" into an innocent-looking "credentials".
    assert.equal(isSecretPath("credentials"), false);
    assert.equal(isSecretPath("credentials", "/home/someone/.aws"), true);
    assert.equal(isSecretPath("config", "/repo/.git"), true);
    assert.equal(isSecretPath("config.json", "/home/someone/.docker"), true);
    assert.equal(isSecretPath("config", "/repo/src"), false);
  });

  it("marks the paths ship must never write: its own config and git internals", () => {
    for (const locked of [
      ".turnpack.json",
      "./.turnpack.json",
      "src/.turnpack.json",
      ".git",
      ".git/config",
      ".git/hooks/pre-commit",
      ".GIT/hooks/x",
      "packages/api/.git/hooks/pre-push",
      "vendor\\lib\\.git\\config",
      "/abs/workspace/.git/hooks/pre-commit",
      "C:\\work\\repo\\.git\\hooks\\pre-commit",
    ]) {
      assert.equal(isProtectedPath(locked), true, locked);
    }
    for (const open of [
      ".github/workflows/ci.yml",
      ".gitignore",
      ".gitattributes",
      "git/hooks/x",
      "docs/turnpack.json",
      "src/my.git.notes.md",
    ]) {
      assert.equal(isProtectedPath(open), false, open);
    }
  });

  it("recognises the Windows spellings that give a file a second name", () => {
    for (const bad of [
      ".env::$DATA",
      ".git::$INDEX_ALLOCATION/hooks/pre-commit",
      "src/key.pem:hidden",
      ".git./hooks/x",
      ".turnpack.json.",
      "dir /file.txt",
      "C:\\repo\\.env::$DATA",
    ]) {
      assert.notEqual(windowsPathProblem(bad), null, bad);
    }
    for (const fine of [
      "src/app.ts",
      ".env.example",
      "C:\\repo\\src\\a.ts",
      "\\\\server\\share\\a.ts",
      "..",
      "./a/../b",
      "a..b/c.d",
      ".gitignore",
      "notes v2.txt",
    ]) {
      assert.equal(windowsPathProblem(fine), null, fine);
    }

    // The name checks see through the same spellings on their own, whatever the caller did first.
    for (const locked of [
      ".git::$INDEX_ALLOCATION/hooks/pre-commit",
      ".GIT./config",
      ".git /hooks/x",
      ".turnpack.json::$DATA",
      "sub/.turnpack.json.",
    ]) {
      assert.equal(isProtectedPath(locked), true, locked);
    }
    for (const secret of [".env::$DATA", "deploy.pem::$DATA", "id_rsa.", ".npmrc ", "home/.aws/credentials::$DATA"]) {
      assert.equal(isSecretPath(secret), true, secret);
    }
    assert.equal(isSecretPath("src/app.ts::$DATA"), false);

    // 8.3 short names: an alias has the short-name shape and is not the name on disk.
    assert.equal(findShortNameAlias("C:\\w\\repo\\GIT~1\\hooks", "C:\\w\\repo\\.git\\hooks", 2), "GIT~1");
    assert.equal(findShortNameAlias("C:\\w\\repo\\SRC\\App.ts", "C:\\w\\repo\\src\\app.ts", 2), null);
    assert.equal(findShortNameAlias("S:\\repo\\v~1\\a.ts", "C:\\real\\repo\\v~1\\a.ts", 2), null);
    // Only the part below the workspace is the caller's to choose.
    assert.equal(findShortNameAlias("C:\\PROGRA~1\\repo\\a.ts", "C:\\Program Files\\repo\\a.ts", 2), null);
  });

  it("on Windows, refuses those spellings before any file is opened", { skip: process.platform !== "win32" }, async () => {
    const SECRET = "TOKEN=not-for-reading";
    fs.writeFileSync(path.join(repoDir, ".env"), `${SECRET}\n`);
    try {
      for (const bad of [
        ".env::$DATA",
        "src/ok.ts::$DATA",
        ".git::$INDEX_ALLOCATION/hooks/pre-commit",
        "src./ok.ts",
        "src/ok.ts.",
        "src /ok.ts",
      ]) {
        assert.throws(() => resolveSafePath(repoDir, bad), /ERR_PATH_ALIAS/, bad);
      }

      // The secret shield matches names, so the same file under another name must never be read.
      const packed = await runPack({ root: repoDir, files: [".env", ".env::$DATA"], inline_only: true });
      assert.equal(packed.includes(SECRET), false);

      delete process.env.TURNPACK_ROOT;
      delete process.env.CLAUDE_PROJECT_DIR;
      const policy = createRootPolicy(repoDir);
      for (const root of ["src::$INDEX_ALLOCATION", "src.", "src ./"]) {
        assert.throws(() => resolveToolRoot(policy, root), /ERR_ROOT_OUTSIDE_WORKSPACE|must be/, root);
      }

      // Short names exist only on volumes that still generate them, so this part runs where it can.
      const longName = "a-directory-with-a-long-name";
      fs.mkdirSync(path.join(repoDir, longName), { recursive: true });
      fs.writeFileSync(path.join(repoDir, longName, "x.txt"), "x\n");
      let shortName = "";
      try {
        shortName = execFileSync(
          "cmd.exe",
          ["/d", "/s", "/c", `"for %I in ("${path.join(repoDir, longName)}") do @echo %~nxsI"`],
          { encoding: "utf8", windowsVerbatimArguments: true },
        ).trim();
      } catch {
        shortName = "";
      }
      if (/~\d/.test(shortName) && shortName.toLowerCase() !== longName) {
        assert.throws(() => resolveSafePath(repoDir, `${shortName}/x.txt`), /ERR_PATH_ALIAS/, shortName);
        assert.throws(() => resolveToolRoot(policy, shortName), /ERR_ROOT_OUTSIDE_WORKSPACE/, shortName);
      }
    } finally {
      fs.rmSync(path.join(repoDir, ".env"), { force: true });
    }
  });

  it("compares directories without being fooled by shared name prefixes", () => {
    assert.equal(isInsideDir(repoDir, repoDir), true);
    assert.equal(isInsideDir(repoDir, path.join(repoDir, "src", "ok.ts")), true);
    assert.equal(isInsideDir(repoDir, outsideDir), false);
    assert.equal(isInsideDir(repoDir, `${repoDir}-sibling`), false);
    assert.equal(isInsideDir(repoDir, path.dirname(repoDir)), false);
  });

  it("resolves a tool root only inside the server's policy", () => {
    const realRepo = fs.realpathSync(repoDir);
    delete process.env.TURNPACK_ROOT;
    delete process.env.CLAUDE_PROJECT_DIR;
    const policy = createRootPolicy(repoDir);
    assert.deepEqual(policy, { roots: [realRepo], source: "cwd" });

    assert.equal(resolveToolRoot(policy), realRepo);
    assert.equal(resolveToolRoot(policy, ""), realRepo);
    assert.equal(resolveToolRoot(policy, "."), realRepo);
    assert.equal(resolveToolRoot(policy, "src"), path.join(realRepo, "src"));
    assert.equal(resolveToolRoot(policy, path.join(repoDir, "src")), path.join(realRepo, "src"));

    for (const escape of ["..", "../outside", outsideDir, path.parse(repoDir).root, "src/../../outside", "missing-dir"]) {
      assert.throws(() => resolveToolRoot(policy, escape), /ERR_ROOT_OUTSIDE_WORKSPACE/, escape);
    }
    assert.throws(() => resolveToolRoot(policy, 42), /must be a string/);
  });

  it("refuses to treat a home, system or credentials directory as a workspace", () => {
    const home = os.homedir();
    for (const broad of [home, path.parse(home).root, path.join(home, ".ssh"), path.join(home, ".aws", "sso")]) {
      assert.equal(isBroadDirectory(broad), true, broad);
    }
    const systemDir = process.platform === "win32" ? process.env.SystemRoot : "/usr";
    if (systemDir) assert.equal(isBroadDirectory(path.join(systemDir, "anything")), true);
    // A temporary directory is a normal place for a checkout, wherever the system keeps it.
    assert.equal(isBroadDirectory(repoDir), false);
    assert.equal(isBroadDirectory(path.join(home, "code", "my-app")), false);

    delete process.env.TURNPACK_ROOT;
    delete process.env.CLAUDE_PROJECT_DIR;
    const unanchored = createRootPolicy(home);
    assert.deepEqual(unanchored, { roots: [], source: "none" });
    assert.throws(() => resolveToolRoot(unanchored), /ERR_NO_WORKSPACE/);
    assert.throws(() => resolveToolRoot(unanchored, "src"), /ERR_NO_WORKSPACE/);
    assert.throws(() => resolveToolRoot(unanchored, home), /ERR_ROOT_TOO_BROAD/);
    assert.throws(() => resolveToolRoot(unanchored, path.join(tmpRoot, "nope")), /ERR_ROOT_NOT_A_DIRECTORY/);
    assert.throws(() => resolveToolRoot(unanchored, 42), /must be a string/);
    const real = fs.realpathSync(repoDir);
    assert.equal(resolveToolRoot(unanchored, repoDir), real);
    // Every directory above a named project is in scope for its verify allowlist.
    assert.deepEqual(configScope(unanchored, real), [path.parse(real).root]);
    assert.deepEqual(configScope(createRootPolicy(repoDir), real), [real]);
    // Folders reported by the client give such a server a normal workspace.
    assert.equal(applyClientRoots(unanchored, [{ uri: pathToFileURL(repoDir).href }]).source, "client");
  });

  it("lets client roots replace the launch directory, but never an explicit TURNPACK_ROOT", () => {
    const realOutside = fs.realpathSync(outsideDir);
    const fromCwd = createRootPolicy(repoDir);

    const adopted = applyClientRoots(fromCwd, [
      { uri: pathToFileURL(outsideDir).href },
      { uri: "https://example.com/not-a-folder" },
      { uri: pathToFileURL(path.join(tmpRoot, "does-not-exist")).href },
      "garbage",
    ]);
    assert.deepEqual(adopted, { roots: [realOutside], source: "client" });
    assert.throws(() => resolveToolRoot(adopted, repoDir), /ERR_ROOT_OUTSIDE_WORKSPACE/);

    assert.equal(applyClientRoots(fromCwd, []), fromCwd);
    assert.equal(applyClientRoots(fromCwd, "nope"), fromCwd);

    // Claude Code names the project through CLAUDE_PROJECT_DIR rather than the launch directory.
    process.env.CLAUDE_PROJECT_DIR = repoDir;
    try {
      const fromProject = createRootPolicy(outsideDir);
      assert.deepEqual(fromProject, { roots: [fs.realpathSync(repoDir)], source: "project" });
      assert.equal(applyClientRoots(fromProject, [{ uri: pathToFileURL(outsideDir).href }]).source, "client");
      process.env.CLAUDE_PROJECT_DIR = path.join(tmpRoot, "does-not-exist");
      assert.equal(createRootPolicy(outsideDir).source, "cwd");
    } finally {
      delete process.env.CLAUDE_PROJECT_DIR;
    }

    const prev = process.env.TURNPACK_ROOT;
    process.env.TURNPACK_ROOT = repoDir;
    try {
      const pinned = createRootPolicy(outsideDir);
      assert.equal(pinned.source, "env");
      assert.equal(applyClientRoots(pinned, [{ uri: pathToFileURL(outsideDir).href }]), pinned);
      process.env.TURNPACK_ROOT = path.join(tmpRoot, "does-not-exist");
      assert.throws(() => createRootPolicy(outsideDir), /does not name an existing directory/);
    } finally {
      if (prev === undefined) delete process.env.TURNPACK_ROOT;
      else process.env.TURNPACK_ROOT = prev;
    }
  });

  it("writes private shards outside the workspace cache dir and respects cache dir isolation", () => {
    const shard = writePrivateShard("unit", "hello shard");
    assert.equal(shard.startsWith(getShardCacheDir()), true);
    assert.equal(shard.startsWith(repoDir), false);
    assert.equal(fs.readFileSync(shard, "utf8"), "hello shard");
  });
});
