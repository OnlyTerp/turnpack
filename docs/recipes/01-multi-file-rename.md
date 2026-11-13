# Recipe 1: a multi-file rename in two calls

Renaming something used across several modules is where agents most often leave a repo half-done. With Turnpack the agent gathers every call site first, then changes them all behind your tests.

**1. `pack` once** to find every use and read the definitions:

```json
{
  "query": "calculateTax",
  "files": [{ "path": "src/tax.ts", "symbol": "calculateTax" }],
  "globs": ["src/**/*.ts", "test/**/*.ts"]
}
```

**2. `ship` once** with every edit and your test command:

```json
{
  "edits": [
    { "path": "src/tax.ts", "search": "export function calculateTax(", "replace": "export function computeTax(" },
    { "path": "src/invoice.ts", "search": "calculateTax", "replace": "computeTax", "replace_all": true },
    { "path": "test/tax.test.ts", "search": "calculateTax", "replace": "computeTax", "replace_all": true }
  ],
  "verify": ["npx tsc --noEmit", "npm test"]
}
```

If one import was missed, the type check fails, every file goes back to exactly how it was, and the agent gets the compiler error naming the file it forgot. Nothing is left half-renamed.

## Renaming or moving a file

`ship` can create and delete files in the same call, so a move is one change too:

```json
{
  "writes": [{ "path": "src/billing/tax.ts", "content": "…the file's contents…" }],
  "deletes": ["src/tax.ts"],
  "edits": [{ "path": "src/invoice.ts", "search": "\"./tax.js\"", "replace": "\"./billing/tax.js\"" }],
  "verify": "npm test"
}
```

On failure the deleted file comes back, and the new file and the `src/billing/` directory created for it are removed.
