# @dbx-tools/core

Node-only core helpers for layered configuration, binary installation, process
execution, locking, and project discovery.

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
- Asynchronous Databricks bundle App-resource streaming with native filesystem
  traversal and CLI-resolved configuration.
- Safe filesystem stat and project naming helpers for CLIs and projen synth.
- Layered config from process env, environment-specific `.env` files, and the
  Databricks bundle's App `config.env`.
- YAML/JSON brand-context discovery and loading with shared Zod validation.
- Idempotent executable downloads with zip/tar extraction and atomic installs.
- Cross-process file locks with a Bun `flock(2)` fast path and a portable,
  stale-reclaiming lock-directory fallback.
- Keyed mutual exclusion across the main thread and its worker threads.

## Install A Binary

```ts
import { join } from "node:path";

import { bin } from "@dbx-tools/core";

const executable = await bin.ensure("tool", releaseUrl, {
  autoUnpackage: true,
  minVersion: "1.2",
  selector: ({ source }) => join(source, "tool"),
});
```

`bin.ensure()` installs to `$HOME/.<name>/bin/<name>` and returns its `root`,
`binDir`, and executable `path`. An existing executable returns immediately, so
a URL resolver is only called when installation is necessary. Concurrent
callers use a file lock with a check-lock-check-load sequence, preventing
duplicate downloads across processes and worker threads. Direct downloads
are selected by default. Zip, tar, tar.gz, and tgz archives can be unpacked
automatically; a single-file archive needs no selector, while a selector can
choose a binary from a larger archive. The selected file is normalized to mode
`0755` and must report an acceptable version before it is atomically moved into
place; the final renamed path runs the same validation again before returning.

Every candidate runs with `--version` before it is accepted. Set
`versionArgument` for a different argument and `minVersion` to require a partial
or complete numeric floor such as `1`, `1.2`, or `1.3.5`. The default parser
searches stdout first, then stderr. It accepts one to three numeric components
with common npm/Python suffixes such as `1.2.3-rc.1`, `1.2.3rc1`, or
`1.2.3.patchdev`; candidates with more components rank first, then the highest
numeric candidate wins. Supply `versionParser({ stdout, stderr })` for another
output format.

Successful installs log an info event with the source URL and destination path;
credentials, query parameters, and fragments are removed from the URL. Set
`LOG_LEVEL=debug` to trace access checks, version decisions, locking, downloads,
archive extraction, and selection.

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

## Resolve Configuration

```ts
import { config } from "@dbx-tools/core";

const publicDomain = config.string(undefined, "PUBLIC_DOMAIN", {
  prefix: "TUNNEL",
});
const timeoutMs = config.positiveInt(undefined, "TIMEOUT_MS", 30_000, {
  prefix: "SEARCH",
});
```

Resolution is lazy and follows constant `data`, process env, `.env`, Databricks
bundle configuration, then `app.yaml` / `app.yml` env values. The default
`DBX_TOOLS` scope and an optional capability prefix produce names such as
`DBX_TOOLS_TUNNEL_PUBLIC_DOMAIN`, then
`TUNNEL_PUBLIC_DOMAIN`, then `PUBLIC_DOMAIN`. `.env.production` and `.env.prod`
are checked before `.env` when `NODE_ENV=production`; development uses
`.env.development` and `.env.dev`.

Pass one config map or an array of maps through `data`; the first matching value
wins before environment lookup by default. When a custom `sources` order omits
`config`, passed data is still read and is appended last. This lets a caller put
env first without accidentally discarding its fallback config:

```ts
const endpoint = config.resolveValue("lakebaseEndpoint", {
  data: { LAKEBASE_ENDPOINT: flags.endpoint },
  sources: ["env", "dotenv", "bundle", "app"],
});
```

`resolveValue()` tries the exact, uppercase, and tokenized-uppercase forms from
`environmentKeys()` before applying normal scope and prefix expansion.

Bundle lookup runs `databricks bundle validate --output json` only after earlier
sources miss. It reads literal values from the single App's `config.env`, accepts
usable partial JSON from a failed validation, and honors the active Databricks
profile. Parsed dotenv records are cached by file path; parsed bundle output is
cached by bundle path plus profile. App YAML lookup runs only if the bundle did
not resolve the key and reads `env[].value` entries. Bundle `value_from` and App
YAML `valueFrom` references resolve supported fields from their named
`sql_warehouse`, `genie_space`, or `postgres` resource. Config-file discovery and parsed results
are single-attempt per source key: found paths, missing files, empty records,
invalid records, and `undefined` results all cache. Root bundle `variables` are NOT a
config source: they are authoring inputs interpolated into the bundle's own
targets, resources, and paths, so reading one as a process setting resolves names
the deployed App never sees. Reference a variable from `config.env` to make it
one.

Bundle lookup is not coupled to AppKit installation or execution context. If
earlier sources miss during local development, the configured working directory
contains a bundle, and bundle reads are enabled, validation runs. This keeps
pre-boot callers such as `@dbx-tools/appkit` auto-configuration on the same
deterministic path as CLIs and ordinary Node consumers.

Deployed Apps skip dotenv, bundle, and app YAML lookup after `isDatabricksAppEnv()`
recognizes the required App name, HTTP(S) host, and valid port. Set
`DBX_TOOLS_DATABRICKS_APP_ENV=true` or `false` to force that result; unrecognized
values leave automatic detection in place.

`DBX_TOOLS_CONFIG_DOTENV`, `DBX_TOOLS_CONFIG_BUNDLE`, and
`DBX_TOOLS_CONFIG_APP` independently force those file sources on or off. A
recognized boolean takes precedence over App
runtime detection, so `true` can enable a local source inside an App and `false`
can suppress it during local development. Absent or unrecognized values keep
the default: read files outside an App and skip them inside one. Bundle reads
also default off when `NODE_ENV=production`; set
`DBX_TOOLS_CONFIG_BUNDLE=true` to opt into bundle validation there.

Use `config.string()`, `boolean()`, `positiveNumber()`, `positiveInt()`,
`port()`, and `list()` to normalize typed options and text-based configuration
through one rule. `config.port()` accepts only TCP ports from 1 through 65535;
`config.ENV_ONLY` disables file fallbacks for exact environment reads.
`config.flattenBundleEnv()`, `flattenAppEnv()`, and `getBundlePath()` expose the
same parsing logic for callers that already have parsed configuration data.

## Discover Bundle App Resources

```ts
import { bundle } from "@dbx-tools/core";

for await (const resource of bundle.appResources(projectRoot, cwd)) {
  consume(resource);
}
```

`appResources()` returns an async generator. It checks bundle files in the
optional working directory's ancestor chain first, then traverses the project
boundary with Node's asynchronous native filesystem APIs. It yields each `resources.apps` entry from
`databricks bundle validate --output json`, so includes, targets, variables,
and relative source paths are resolved by the Databricks CLI. It does not
require `app.yml` or `app.yaml`. Each resource includes its App `config` and the
complete resolved bundle `data`.

A failed validation that still returns partial App resources attaches
`bundleFailure` to those resources. Failed bundles with no App resources yield
nothing. Missing, invalid, or out-of-bound project paths also yield nothing.
Malformed successful CLI output throws while the generator is consumed.

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

When an executable is missing, `spawn()` and `spawnSync()` return
`exec.COMMAND_NOT_FOUND_EXIT_CODE` (`127`) unless `check: true` is set. With
`check: true`, they throw like any other non-zero exit.

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

## Serialize Work Across Threads

```ts
import { processLock } from "@dbx-tools/core";

await processLock.withProcessLock(["cache", name], async () => {
  if (!(await exists(name))) await build(name);
});
```

`withProcessLock()` runs the callback while holding the named lock, releasing it
when the callback settles. Callers sharing a key are serialized; distinct keys
run concurrently. The key is any value with a stable identity - a string, a
`["invoice", id]` tuple, a config object - canonicalized by `object.toStableKey`,
so structure counts: `["invoice", 7]` and `"invoice_7"` are different locks.

Use it instead of a module-level promise chain when worker threads are involved.
A promise chain only serializes the thread it lives on, so a worker pool runs one
callback per thread; the coordinator here is shared, so the key admits one
callback for the whole process.

Workers opt in when they are constructed:

```ts
import { Worker } from "node:worker_threads";

new Worker(url, processLock.processLockWorkerOptions({ workerData: { tenant } }));
```

That preserves your own `workerData` and `transferList`, and lets the worker lock
during module initialization. For a worker you did not construct, call
`attachProcessLock(worker)` and have the worker `await processLockAttached()`
first - the port arrives by message, so it is not available quite as early.

A thread that exits while holding a lock releases it, so a crashed worker cannot
wedge a key. Locks are held only as long as the callback runs, and an idle lock
never keeps the process from exiting.

The scope is the THREADS of one process - `withProcessLock` shares nothing with a
second `node` invocation or another replica. When the critical section spans a
deployment, use
[`@dbx-tools/postgres`](../postgres)'s `withAdvisoryLock`, which puts the arbiter
in PostgreSQL where every replica can see it.

## Serialize Work Across Processes

```ts
import { fileLock } from "@dbx-tools/core";

await fileLock.withFileLock(["cache", name], async () => {
  if (!(await exists(name))) await build(name);
});
```

`withFileLock()` serializes processes on the same machine or shared filesystem.
Under Bun on Unix it prefers a kernel `flock(2)` lock, which the OS releases if
the process dies. Plain Node, Windows, and systems without the FFI path use
atomic lock-directory creation with a heartbeat and stale-lock reclamation.
Callers can select the lock directory, restrict the backend cascade, observe the
chosen backend, or set a wait timeout. Lock keys use the same stable structured
identity as process and Postgres advisory locks.

Use `processLock.withProcessLock()` when only threads in one process compete,
`fileLock.withFileLock()` when local processes compete, and Postgres advisory
locks when multiple app replicas need one arbiter.

## Discover Project Roots

```ts
import { project } from "@dbx-tools/core";

const root = project.root();
const name = project.name();
const origins = [...project.resolveProjectRoots(process.cwd())];
const cwd = project.resolveWorkingDirectory("");
```

`project.root()` checks npm/pnpm workspace roots, git top-level, and cwd.
`project.name()` prefers package metadata, then git remote name, then directory
basename. `project.resolveWorkingDirectory()` normalizes blank, null, omitted,
relative, and absolute cwd values for cache decisions. Project subprocess probes
share a command/argument result cache only when that resolved path is the live
process cwd; another directory executes directly. Empty command results are
cached too.

## Modules

- `exec` - async/sync process spawning, stdio handling, abort wiring, and shlex.
- `bin` - executable download, optional archive extraction, selection, and
  atomic installation.
- `bundle` - asynchronous streaming of CLI-resolved Databricks bundle App resources.
- `project` - cwd normalization, root discovery, project naming, and git-remote
  parsing.
- `file` - best-effort stat and parsed-record caching by caller-defined source key.
- `brand` - YAML/JSON discovery, parsing, validation, and asset path resolution.
- `config` - scoped environment, dotenv, and validated Databricks bundle lookup,
  including runtime detection and typed coercion helpers.
- `file` - best-effort filesystem stat.
- `fileLock` - cascading cross-process locks using `flock` or portable lock
  directories.
- `processLock` - keyed mutual exclusion across the main thread and its workers,
  with worker wiring (`processLockWorkerOptions`, `attachProcessLock`,
  `processLockAttached`).
