# @dbx-tools/node-appkit-config

Auto-configuration for AppKit apps. The headline export is `createApp`: a
drop-in replacement for `@databricks/appkit`'s `createApp` that resolves and
applies the environment each enabled capability needs, then delegates to the
real `createApp` unchanged.

```ts
import { createApp } from "@dbx-tools/node-appkit-config";
import { lakebase, server } from "@databricks/appkit";

// Resolves Lakebase Postgres env vars (because `lakebase()` is present),
// grants the cache schema, then hands the same config to AppKit's createApp.
await createApp({ plugins: [server(), lakebase()] });
```

Auto-config runs BEFORE delegating so plugins see a fully populated
`process.env` during their synchronous `setup()`. Lakebase Postgres resolves
when a `lakebase` plugin is present, or when `autoConfigure: true` is set.

## Modules

- `createApp` - the drop-in wrapper + `autoConfigure`.
- `lakebaseResolver` - resolve a full Postgres connection from env / config /
  the Lakebase Autoscaling REST API (reverse-lookup, pick, or auto-create a
  project), and `applyLakebaseToEnv`.
- `pgaddress` - flexible parser for `LAKEBASE_ENDPOINT` inputs (Postgres URIs,
  resource paths, bare hosts / project ids).
- `provision` - grant the connecting role rights on the AppKit cache schema.

## CLI

```sh
appkit-config-env [--format export|windows|json] [--quiet]
```

Runs auto-config and prints the env vars it added/changed as eval-able shell
`export` / Windows `set` lines (or JSON) - `eval "$(appkit-config-env)"` to load
a resolved Lakebase connection into your current shell.

Requires `@databricks/appkit` at runtime (it wraps `createApp` /
`createLakebasePool`). Config resolution comes from
[`@dbx-tools/node-appkit`](../appkit) (`config`); project-name discovery from
[`@dbx-tools/node-core`](../core) (`project`).
