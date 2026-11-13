# Recipe 2: Test-Gated Refactor with Strict Verify Allowlist

Want `ship` restricted to pre-approved test commands in your repo? Create `.turnpack.json` at the root:

```json
{
  "enforceVerifyAllowlist": true,
  "allowedVerify": ["npm test", "node --test", "pytest"]
}
```

Any `ship` verification command outside that allowlist aborts cleanly (`ABORTED_BEFORE_WRITE`) without touching disk.
