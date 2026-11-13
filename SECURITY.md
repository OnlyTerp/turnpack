# Security Policy & Trust Boundary

Turnpack runs 100% locally on your machine with **zero cloud API keys**, **zero external model calls**, and **zero product telemetry**.

## Default Defenses

1. **Workspace Confinement (`resolveSafePath`)**: All file reads, writes, searches, and edits resolve symlinks via `fs.realpathSync` and reject paths outside the workspace root (including Windows cross-drive targets and symlinked directories leading outside the repo).
2. **Default Secret Shield (`isSecretPath`)**: `.env`, `.env.*` (except `.env.example`, `.env.sample`, `.env.template`, `.env.schema`), `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.kdbx`, SSH private keys (`id_rsa`, `id_ed25519`, etc.), `.git-credentials`, `.npmrc`, `.pypirc`, `.netrc`, `credentials.json`, `service-account*.json`, and `.aws/credentials` are automatically redacted in `pack` and `batch` and blocked from edits in `ship` unless `allow_secrets: true` is explicitly passed.
3. **Read-Only `batch` by Default**: `ctx.exec` is disabled unless `TURNPACK_ALLOW_EXEC=1` is explicitly exported. `node:vm` is an isolation convenience for in-process scripts, not an OS security sandbox — enabling `TURNPACK_ALLOW_EXEC=1` runs commands with your normal user permissions.
4. **Optional Verification Allowlist (`.turnpack.json`)**: Add `{ "enforceVerifyAllowlist": true, "allowedVerify": ["npm test", "node --test"] }` in your repo root if you want `ship` to restrict verification commands strictly to approved prefixes.
5. **Private Shard Cache**: Overflow shards are stored inside your per-user cache directory (`LOCALAPPDATA/turnpack/shards` on Windows, `XDG_CACHE_HOME/turnpack/shards` or `~/.cache/turnpack/shards` on POSIX) with restrictive permissions (`0700`/`0600`), 24h TTL cleanup, and a 10 MB cap. Your Git working tree stays untouched.
6. **Zero Third-Party Dependencies**: `package.json` declares `"dependencies": {}` to eliminate transitive runtime supply-chain risk.

## Reporting a Vulnerability

Please report security issues privately via GitHub Security Advisories on `OnlyTerp/turnpack` rather than opening a public issue.
