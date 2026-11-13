# Recipe 1: Clean Multi-File Rename in Two Local Calls

When renaming a shared helper across several modules, let your AI gather every call site first with `pack` and apply + test the whole rename with `ship`:

1. Call `pack` once with `query: "oldFunctionName"` and `globs: ["src/**/*.ts", "test/**/*.ts"]`.
2. Call `ship` once with `edits` across every file plus `verify: "npm test"`.

If even one missed import or type error breaks `npm test`, `ship` restores every file automatically and shows the exact compiler error so nothing gets stuck half-renamed.
