# @dbx-tools/path

Discover, match, ignore, scan, and watch filesystem paths with the same rules
used by the CLI, Projen, barrel generation, code generation, and documentation
tooling.

## Find files

```ts
import { find, ignore } from "@dbx-tools/path";

for await (const file of find.findFiles(["packages/**/src/**/*.ts"], {
  ignore: ignore.ignorePatterns(),
})) {
  await processFile(file);
}

const files = find.findFilesSync(["packages/**/src/**/*.ts"]).toArray();
```

`find.findFiles()` streams matches asynchronously. `find.findFilesSync()`
returns a lazy `Sequence<string>` from
[@dbx-tools/shared-core](../../shared/core), so callers can map/filter without
materializing immediately.

The package also provides glob matchers, shared ignore rules, workspace package
scanning, and Chokidar-based watch helpers.

Use this package instead of direct `glob` or `chokidar` calls when the result
should agree with package discovery, barrel generation, or cleanup logic.

## Compile matchers

```ts
import { match } from "@dbx-tools/path";

const isTest = match.toPathMatcher("**/*.test.ts");
if (isTest("packages/shared/model/test/classify.test.ts")) {
  skip();
}
```

`match.toPathMatcher()` returns a composable shared-core predicate. Use
`match.pathMatchTests()` when you need to inspect the compiled include/exclude
tests.

## Reuse ignore rules

```ts
import { ignore } from "@dbx-tools/path";

const matcher = ignore.ignorePathMatcher({
  defaults: true,
  dot: true,
  test: false,
  lock: "auto",
});
```

The ignore helpers centralize repo-wide exclusions such as `node_modules`,
generated files, build output, VCS metadata, and package-manager output.

## Scan workspace packages

```ts
import { scan } from "@dbx-tools/path";

const options: scan.FileScanOptions = {
  cwd: "packages",
  ignore: ["generated/**"],
  followSymlinks: scan.FOLLOW_SYMLINKS_DEFAULT,
};
```

`scan` exports shared scan option types used by the projen engine. Use the same
options when implementing docs or analysis tools that should walk the workspace
like synthesis does.

## Watch files

```ts
import { watch } from "@dbx-tools/path";

const watcher = await watch.watchFiles(["packages/**/src/**/*.ts"], {
  ignoreInitial: true,
});

watcher.on("change", (file) => rebuild(file));
```

`watch.watchFiles()` wraps chokidar with the same path and ignore expectations
used by the rest of the repo tooling.

## Build patterns

```ts
import { pattern } from "@dbx-tools/path";

const nodeModulesPattern = pattern.directoryNamePattern("node_modules");
const tsPattern = pattern.fileExtensionPattern("ts");
```

Pattern helpers keep generated glob fragments escaped and consistent.

## Modules

- `find` - glob-backed lazy file finding.
- `match` - glob-to-predicate path matchers.
- `ignore` - standard ignore pattern and matcher construction.
- `scan` - package scan option types and defaults.
- `watch` - chokidar wrapper for file watching.
- `pattern` - escaped directory-name and extension glob fragments.

The projen engine uses this package in
[@dbx-tools/projen](../../../../projen).
