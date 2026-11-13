# Recipe 4: when not to use Turnpack

A tool that removes round trips is overhead when there are none to remove.

- **A one-line fix in a file the agent already has open.** Use the app's normal edit tool. One call is one call.
- **Pasting a whole repository into a browser chat.** Use [Repomix](https://github.com/yamadashy/repomix). Turnpack is for an agent working inside a repo, a slice at a time.
- **A project with no fast check.** `ship` is at its best when a test, type check or build answers in seconds. If your only verification takes ten minutes or does not exist, `ship` is still a validated multi-file edit, but the rollback has nothing to react to.
- **Changes whose effects are outside the repo.** Rollback restores files. It does not undo a database migration, a deploy or a published package that your verify command triggered. Do not put those in `verify`.
- **Running commands from `batch`.** Leave `TURNPACK_ALLOW_EXEC` off. `batch` is for reading and summarising; commands belong in `ship`'s `verify`, where a failure rolls the edit back.
