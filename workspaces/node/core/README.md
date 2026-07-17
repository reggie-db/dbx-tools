# @dbx-tools/core

Node-only core helpers for process execution and project discovery.

Import this package when code needs `node:child_process`, `node:fs`, or
`node:path`. Browser-safe utilities live in
[`@dbx-tools/shared-core`](../../shared/core).

Key features:

- Async and sync process execution with consistent stdio handling.
- AbortSignal support for long-running subprocesses.
- Small shell-like argument splitting for command strings that must become argv
  arrays.
- Workspace/project root discovery from package-manager files, git metadata, and
  the current working directory.
- Safe filesystem stat and project naming helpers for CLIs and projen synth.
- YAML/JSON brand-context discovery and loading with shared Zod validation.

## Load Brand Context

```ts
import { brand } from "@dbx-tools/core";

const context = await brand.loadBrandContext();
```

`loadBrandContext()` searches known npm/git project roots for
`branding/brand.yaml`, `.yml`, or `.json`, followed by equivalent root-level
files. Missing files return the complete dbx tools default context; malformed
files fail validation. Use `loadBrandContextFile(path)` for an explicit file and
`resolveBrandAssetPath(path, asset)` for relative asset references.

## Run Commands

```ts
import { exec } from "@dbx-tools/core";

const result = await exec.spawn("git", ["status", "--short"], {
  stdout: "capture",
  stderr: "capture",
});

if (result.exitCode !== 0) {
  throw new Error(result.stderr);
}
```

`exec.spawn()` supports inherited, piped, ignored, captured, and line-callback
stdio. It accepts string stdin and abort signals, making it useful for CLIs and
watch tasks.

Prefer `spawn()` over ad hoc `child_process` calls when command output needs to
be captured, streamed line-by-line, or aborted consistently from higher-level
tooling.

## Run Synchronously

```ts
const rev = exec
  .spawnSync("git", ["rev-parse", "HEAD"], {
    stdout: "capture",
  })
  .stdout.trim();
```

Use `spawnSync()` during projen synthesis or config discovery where async
control flow is not available.

## Split Shell-Like Commands

```ts
const argv = exec.shlex('pnpm exec prettier --write "README.md"');
```

`shlex()` is a small parser for command strings that need to become argv arrays.
Prefer explicit argv arrays when possible.

## Discover Project Roots

```ts
import { project } from "@dbx-tools/core";

const root = project.root();
const name = project.name();
const origins = [...project.resolveProjectRoots(process.cwd())];
```

`project.root()` checks npm/pnpm workspace roots, git top-level, and cwd.
`project.name()` prefers package metadata, then git remote name, then directory
basename. `project.stat()` returns `undefined` instead of throwing.

## Modules

- `exec` - async/sync process spawning, stdio handling, abort wiring, and shlex.
- `project` - root discovery, project naming, git-remote parsing, and safe
  filesystem stat.
- `brand` - YAML/JSON discovery, parsing, validation, and asset path resolution.
