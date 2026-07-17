# @dbx-tools/node-file-scan

Filesystem glob / ignore / watch helpers built on `glob`, `minimatch`, and
`chokidar`. Node-tagged (it shells out via [`@dbx-tools/node-core`](../core) and
uses `node:*`), so it lives under `workspaces/node/`.

```ts
import { find, match, ignore, watch } from "@dbx-tools/node-file-scan";

for (const file of find.findFiles("src/**/*.ts", { ignore: ignore.ignorePatterns() })) {
  // ...
}
const isMatch = match.toPathMatcher("**/*.test.ts");
```

## Modules

- `find` - `findFiles` glob walk returning a lazy `Sequence`.
- `match` - compile globs into shared-core `predicate.Predicate` path matchers.
- `ignore` - default ignore-pattern set (node_modules, generated files, …).
- `watch` - `watchLoop` over a chokidar watcher for source edits.

Consumed by the projen engine ([`@dbx-tools/projen`](../projen)) for package
discovery, barrels, and the sync watcher.
