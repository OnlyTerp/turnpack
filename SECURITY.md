# Security model

Turnpack runs entirely on your machine. It makes no network requests, needs no API keys, collects no telemetry, and has zero runtime dependencies.

This page says what Turnpack defends against, how, and where each defence stops. If you find a way through one of them, please [report it privately](#reporting-a-vulnerability).

## Who the adversary is

The caller of every tool is a language model. Usually it is cooperative and occasionally careless. Sometimes it is steered by text it read in your repo, a web page or an issue (prompt injection). So every tool argument is treated as untrusted input, and nothing the model passes can widen what a tool is allowed to touch.

What Turnpack does **not** try to be is a sandbox for your whole agent. Your AI app very likely has its own shell and file tools. Turnpack's job is to make sure that *its* tools do not hand the model anything those permission prompts would not.

## The fences

### 1. Workspace jail

Every read, search, write and delete is confined to the workspace. The workspace is decided on the server side, from the first of these that is set:

1. `TURNPACK_ROOT`: one directory, or several separated by `:` (`;` on Windows).
2. MCP `roots`: the folders your app reports for the session. Claude Code reports the project directory and anything added with `--add-dir`.
3. `CLAUDE_PROJECT_DIR`: set by Claude Code for the servers it starts.
4. The directory the server process was started in.

The `root` / `cwd` argument on a tool call may select a directory inside that boundary. It cannot leave it: `"/"`, `".."` and absolute paths elsewhere are refused with `ERR_ROOT_OUTSIDE_WORKSPACE`.

Inside the workspace, each path is resolved through symlinks before it is checked, including the existing part of a path that does not exist yet. That covers dangling links too: a symlink whose target does not exist yet is followed to where a write would land, so it cannot be used to create a file outside the workspace or inside `.git`. A symlink in your repo that points outside it cannot be read or written through. Windows drive letters and case-insensitivity are handled.

Windows also gives a file more than one name. `.env::$DATA` is `.env` (NTFS stream syntax), `.git::$INDEX_ALLOCATION` is the `.git` directory, a name with a trailing dot or space can open the name without it, and `GIT~1` is the 8.3 short name of `.git`. Every fence below compares names, so on Windows all of these spellings are refused with `ERR_PATH_ALIAS` before any file is opened, in file paths and in `root` / `cwd` alike. Short names are detected by asking the file system for the path's real name.

**Where it stops:** if your app starts the server somewhere broad (your home directory) and supplies none of the above, that directory is the workspace. Set `TURNPACK_ROOT` to be explicit.

### 2. Secret shield

These files are redacted from `pack` and `batch` output and refused by `ship`, unless the call passes `allow_secrets: true`:

- `.env`, `.env.*`, `*.env`, `.envrc` (but not `.env.example`, `.env.sample`, `.env.template`, `.env.schema`, `.env.defaults`, `example.env`, `sample.env`, `template.env`)
- `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.ppk`, `*.jks`, `*.keystore`, `*.kdbx`
- `id_rsa`, `id_ed25519`, `id_ecdsa`, `id_dsa` (their `.pub` halves are allowed)
- `.npmrc`, `.pypirc`, `.netrc`, `.pgpass`, `.htpasswd`, `.git-credentials`, `.dockercfg`
- `credentials.json`, `service-account*.json`, `secrets.{json,yml,yaml,toml}`, `kubeconfig`
- `.aws/credentials`, `.docker/config.json`, `.kube/config`, `.git/config`
- `*.tfstate`, `*.tfstate.backup`, `*.tfvars`

**Where it stops:** the list matches file names, not file contents. A key pasted into `config.js` is not detected. And `allow_secrets` is an argument the model can set. The shield stops secrets from leaking by accident, which is how they usually leak. It is not access control.

### 3. Read-only `batch`

A `batch` script is model-written code, so it gets two independent layers.

**Layer one, the script's own world.** The script runs in a `node:vm` context that is given no object from the host. That matters because every host object carries a path back to the host's `Function` constructor, and from there to `process`. The `ctx` helpers are defined inside the context and talk to the host through a bridge that passes strings only. `eval`, `new Function`, WebAssembly and `import()` are disabled.

**Layer two, the process.** The context lives in a separate, short-lived Node process started with Node's [permission model](https://nodejs.org/api/permissions.html):

- no file writes anywhere
- no child processes, no worker threads
- file reads limited to the workspace and Turnpack's own code
- a minimal environment: your API keys and tokens are not passed in
- a memory cap, and a wall-clock limit enforced by the parent, which kills the process

Anything that needs more (ripgrep for `ctx.grep`, git for `ctx.gitStatus`) is done by the parent on the script's behalf. The parent decides the workspace and the secret policy itself and does not take them from the child.

The test suite deliberately breaks layer one and checks that layer two still refuses the write, the shell command and the out-of-workspace read.

**Where it stops:**

- `node:vm` is not a security boundary, and Node describes its permission model as protection against trusted code doing something unintended, not against determined malicious code. Two layers make an escape much harder. They do not make it impossible.
- Node's permission model does not restrict **network access** on Node 22. A script that broke out of layer one could send what it can read.
- The permission model follows symlinks when reading. `ctx.read` refuses symlinks that leave the workspace, but that check is part of layer one.
- A script that broke out of layer one could read a secret file directly instead of through `ctx.read`.
- If your Node build cannot start the runner with the permission model, Turnpack falls back to layer one plus the separate process. `npx turnpack doctor` tells you which mode you have.
- `TURNPACK_ALLOW_EXEC=1` enables `ctx.exec`, which runs shell commands as you. The tool then stops advertising itself as read-only.

### 4. `ship`

`ship` writes files and runs commands. That is its purpose, and your AI app should ask you before allowing it. Within that:

- **Validate, then write.** Every edit, write and delete is checked in memory first. A missing anchor, an ambiguous anchor, a path outside the workspace or a secret file aborts the whole call with nothing written.
- **Protected paths.** `ship` never modifies a `.turnpack.json` or anything inside a `.git` directory, at any depth, whatever the arguments, and whether the path is named directly or reached through a symlink. The first holds the verify allowlist; the second holds hooks and config that run on your next ordinary git command. Nested repositories and submodules are covered too.
- **Byte-exact rollback.** Snapshots are taken before the first write and verified by SHA-256 when restored. Files that were created are removed, along with directories created for them. Deleted files come back with their original mode.
- **Your changes are not rolled back with it.** Before restoring a file, `ship` checks that it still holds what `ship` wrote. If something else changed it while verify was running (you saved it in your editor), that file is left as it is, the rest are restored, and the reply is `FAILED_ROLLBACK_PARTIAL` with the file named.
- **Interruptions.** If the server receives SIGINT, SIGTERM or SIGHUP while verify is running, it stops the verify command and restores the snapshots before exiting.
- **No writing through links.** A write to a symlink lands on the file it resolves to, after that file has passed every check above. The link itself is never replaced, and a path that turns out to be a link at the moment of writing is refused.
- **Text only.** Search-and-replace edits are refused on files that are not valid UTF-8, so bytes the edit never mentioned cannot be corrupted.
- **One at a time.** Concurrent `ship` calls are queued.
- **No waiting on leftovers.** `ship` returns when the verify command itself exits. A background process the command leaves behind (a dev server a test started and never stopped) does not hold the call, or the calls queued behind it, open.

**The verify allowlist** is optional. Put this in `.turnpack.json` at the workspace root:

```json
{
  "enforceVerifyAllowlist": true,
  "allowedVerify": ["npm test", "npx tsc --noEmit", "pytest"]
}
```

A call may name a subdirectory as its `cwd`. Every `.turnpack.json` from that directory up to the workspace root is enforced, so stepping into a subdirectory does not step out from under the list.

A command is accepted only if it equals an entry exactly. Extra arguments are refused by default, because arguments change what a command runs: `npm test --prefix other/` and `node --test --import ./x.mjs` are not the commands you approved. To allow trailing arguments for one command, end its entry with ` *` (for example `"pytest *"`). Even then, anything containing `; & | < > $ ( )`, backticks or newlines is refused, so `pytest && curl … | sh` does not pass. If the file exists but is not valid, verify is refused rather than allowed.

**Where it stops:**

- The verify command runs your project's code, and `ship` edits your project's code, including the `test` script in `package.json` or a `Makefile` target, in the same call if it likes. The allowlist stops the agent from launching commands you did not approve, such as a deploy script or `curl … | sh`. It does not stop a hijacked agent from changing what an approved command does. For that you need review, or a sandbox around the whole agent.
- Snapshots are held in memory. `kill -9`, a crash of the host, or a power cut during verify leaves the edits on disk.
- Rollback restores files `ship` changed. It does not undo what the verify command did: a migrated database, generated files, a published package.
- `ship` cannot tell your save from a verify command that rewrites the files being shipped (a formatter with `--fix`). Either way those files are left as they are and the reply says which.
- A process the verify command leaves running is not stopped by `ship`. On a timeout the command and its process tree are killed, but a process that detached itself from that tree survives.
- Without the allowlist, `verify` is an arbitrary shell command chosen by the model.

### 5. Everything else

- **Argument handling.** Search patterns are passed to ripgrep as data (`-e pattern -- path`), never as flags.
- **Runaway patterns.** When ripgrep is missing, or rejects a pattern it does not support (look-around, backreferences), search falls back to JavaScript's regex engine, and glob listings are matched with regexes too. Those can take exponential time on the wrong pattern, so that work runs in a worker thread with a five-second deadline and is abandoned at it. One bad pattern costs one call, not the server.
- **Overflow files.** Oversized `pack` output is written to a per-user cache directory (`%LOCALAPPDATA%\turnpack\shards`, or `$XDG_CACHE_HOME/turnpack/shards`, or `~/.cache/turnpack/shards`) with `0700`/`0600` permissions, a 24-hour lifetime and a 10 MB cap. Nothing is written into your repo.
- **The installer.** `turnpack init` previews every change, backs up each file as `*.turnpack.bak`, writes atomically, and skips any config it cannot parse instead of rewriting it.
- **Supply chain.** No runtime dependencies. The release workflow publishes with [npm provenance](https://docs.npmjs.com/generating-provenance-statements), so a published version can be traced to the commit that built it. The configs `init` writes use `npx -y turnpack serve`, which runs the latest published version each time your app starts; pin a version (`turnpack@0.1.0`) if you would rather update deliberately.

## Checking it yourself

```bash
npx turnpack doctor
```

runs the real server and checks the secret shield, the workspace jail and the `batch` isolation mode on your machine. The attack tests are in [`test/`](test): sandbox escapes and runaway scripts in `pack-batch.test.mjs`, allowlist smuggling and protected paths in `ship.test.mjs`, jail and root handling in `mcp-cli.test.mjs` and `security.test.mjs`.

## Reporting a vulnerability

Please use [GitHub Security Advisories](https://github.com/OnlyTerp/turnpack/security/advisories/new) for `OnlyTerp/turnpack` rather than a public issue. Include the Turnpack version, your OS and Node version, and the smallest tool call that shows the problem. Fixes are credited in the changelog unless you would rather not be named.
