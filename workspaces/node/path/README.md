# @dbx-tools/node-path

Node filesystem path toolkit for discovery, matching, ignoring, scanning, and
watching.

Import this package when Node code needs consistent glob behavior across CLI,
projen, barrel generation, OpenAPI generation, or docs tooling.

Key features:

- Lazy glob-backed file discovery that composes with shared-core sequences.
- Glob-to-predicate matchers for include/exclude logic.
- Centralized ignore rules for generated files, dependencies, package-manager
  output, VCS folders, and build artifacts.
- Workspace scan option types shared by synthesis and docs tooling.
- Chokidar wrapper for watch loops that should follow the same ignore behavior.
- Escaped glob pattern builders for generated matcher fragments.

## Find Files

```ts
import { find, ignore } from "@dbx-tools/node-path";

const files = find
  .findFiles(["workspaces/**/src/**/*.ts"], {
    ignore: ignore.ignorePatterns(),
  })
  .toArray();
```

`find.findFiles()` returns a lazy `Sequence<string>` from
[`@dbx-tools/shared-core`](../../shared/core), so callers can map/filter without
materializing immediately.

Use this package instead of direct `glob` or `chokidar` calls when the result
should agree with package discovery, barrel generation, or cleanup logic.

## Compile Matchers

```ts
import { match } from "@dbx-tools/node-path";

const isTest = match.toPathMatcher("**/*.test.ts");
if (isTest("workspaces/shared/model/test/classify.test.ts")) {
  skip();
}
```

`match.toPathMatcher()` returns a composable shared-core predicate. Use
`match.pathMatchTests()` when you need to inspect the compiled include/exclude
tests.

## Reuse Ignore Rules

```ts
import { ignore } from "@dbx-tools/node-path";

const matcher = ignore.ignorePathMatcher({
  generated: true,
  dependencies: true,
  vcs: true,
});
```

The ignore helpers centralize repo-wide exclusions such as `node_modules`,
generated files, build output, VCS metadata, and package-manager output.

## Scan Workspace Packages

```ts
import { scan } from "@dbx-tools/node-path";

const options: scan.FileScanOptions = {
  roots: ["workspaces", "example-workspaces"],
  followSymlinks: scan.FOLLOW_SYMLINKS_DEFAULT,
};
```

`scan` exports shared scan option types used by the projen engine. Use the same
options when implementing docs or analysis tools that should walk the workspace
like synthesis does.

## Watch Files

```ts
import { watch } from "@dbx-tools/node-path";

const watcher = watch.watchFiles(["workspaces/**/src/**/*.ts"], {
  ignoreInitial: true,
});

watcher.on("change", (file) => rebuild(file));
```

`watch.watchFiles()` wraps chokidar with the same path and ignore expectations
used by the rest of the repo tooling.

## Build Patterns

```ts
import { pattern } from "@dbx-tools/node-path";

const nodeModulesPattern = pattern.directoryNamePattern("node_modules");
const tsPattern = pattern.fileExtensionPattern("ts");
```

Pattern helpers keep generated glob fragments escaped and consistent.

## Modules

- `find` - glob-backed lazy file finding.
- `match` - glob-to-predicate path matchers.
- `ignore` - standard ignore pattern and matcher construction.
- `scan` - workspace package scan option types and defaults.
- `watch` - chokidar wrapper for file watching.
- `pattern` - escaped directory-name and extension glob fragments.

The projen engine uses this package in
[`@dbx-tools/projen`](../projen).
