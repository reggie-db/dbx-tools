# @dbx-tools/shared-core

The light, **browser-safe** base every `@dbx-tools/*` package builds on.
Dependency-free runtime helpers with no `node:*` imports and no DOM - the
agnostic tsconfig floor plus the `WebWorker` lib, so the same code runs in a
browser, a worker, or Node.

Each concern is its own module, exposed as a namespace on the barrel so call
sites read naturally and never collide with similarly named helpers:

```ts
import { async, error, hash, string, object, log } from "@dbx-tools/shared-core";

const slug = string.toSlug("Cool Dude"); // "cool-dude"
const same = object.deepEqual(a, b);
const logger = log.logger("my/module");
```

Unique **types** are hoisted flat, so you can import them directly:

```ts
import { type PollContext, type Logger } from "@dbx-tools/shared-core";
```

## Modules

- `async` - `poll` / `sleep` / `tieAbortSignal` (WHATWG `AbortSignal`-based).
- `error` - `errorMessage` / `errorMessages` / `errorNodes` / `toError`.
- `hash` - `fnvHash` / `fnvHashWithOptions` / `toBase32` / `id` (non-crypto).
- `string` - `tokenize` / `toSlug` / `toIdentifier` / `firstNonEmpty` / … .
- `object` - `isRecord` / `toBoolean` / `deepEqual` + `NameLike` shape types.
- `log` - tagged, leveled `logger` (lazy consola, console fallback).
- `functionModule` (`memoize`), `iterable`, `predicate`.

Node-only helpers (`exec`, `project`) live in
[`@dbx-tools/node-core`](../../node/core); the Databricks App env check lives in
[`@dbx-tools/node-appkit`](../../node/appkit) (`databricks.isAppEnv`).

## Optional dependency

`consola` is an optional peer: `log` lazy-imports it and degrades to a `console`
fallback when it's absent, so consumers may leave it uninstalled.
