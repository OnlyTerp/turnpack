# Recipe 4: When Not to Use Turnpack

Honest engineering means knowing when a tool is overhead:

- **One-line typo inside a single known file:** Use your editor or your AI app's built-in single-file edit tool directly — there are no extra turns to save.
- **Dumping an entire repo into a browser chat window:** Use `Repomix` for whole-repo Markdown snapshots; Turnpack is built for selective slicing and test-gated local edits inside agent workflows.
- **Unattended shell execution inside `batch`:** Leave `batch` read-only unless you explicitly need local execution (`TURNPACK_ALLOW_EXEC=1`), and keep critical verification inside `ship`.
