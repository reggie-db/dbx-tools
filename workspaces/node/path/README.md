# @dbx-tools/node-path

Filesystem path helpers built on `glob`, `minimatch`, and `chokidar`: glob
find, ignore rules, path matching, package scanning, and file watching. More
than just matching - it's the path toolkit the projen engine uses for discovery,
barrels, and the sync watcher. Node-tagged (it shells out via
[`@dbx-tools/node-core`](../core) and uses `node:*`), so it lives under
`workspaces/node/`.

```ts
import { find, match, ignore, watch, scan } from "@dbx-tools/node-path";

for (const file of find.findFiles("src/**/*.ts", { ignore: ignore.ignorePatterns() })) {
  // ...
}
const isMatch = match.toPathMatcher("**/*.test.ts");
```

## Modules

- `find` - `findFiles` glob walk returning a lazy `Sequence`.
- `match` - compile globs into shared-core `predicate.Predicate` path matchers.
- `ignore` - default ignore-pattern set (node_modules, generated files, …).
- `pattern` - glob/pattern parsing + partitioning helpers.
- `scan` - workspace package discovery (`src`-bearing folder walk).
- `watch` - `watchLoop` over a chokidar watcher for source edits.

Consumed by the projen engine ([`@dbx-tools/projen`](../projen)).
