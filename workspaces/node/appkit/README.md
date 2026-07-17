# @dbx-tools/node-appkit

Node-side Databricks + AppKit glue, so the browser-safe
[`@dbx-tools/shared-core`](../../shared/core) stays SDK-free. Everything that
needs `@databricks/appkit` or the Databricks SDK - but no heavier deps than
those - lives here.

```ts
import { databricks, appkit, plugin, config, createApp } from "@dbx-tools/node-appkit";

const ctx = databricks.toContext(controller, options.context); // SDK cancellation
const client = appkit.tryGetExecutionContext()?.client;        // OBO workspace client
const lake = plugin.instance(this.context, lakebase);          // sibling plugin lookup
const warehouse = await config.resolveConfigValue("SQL_WAREHOUSE_ID"); // env/bundle
await createApp.createApp({ plugins: [server(), lakebase()] }); // auto-config + createApp
```

## Modules

- `databricks` - generic Databricks SDK glue (no AppKit): the
  `Context`/`AbortSignal` cancellation adapter (`toContext`, `ContextLike`) and
  `isAppEnv` (Databricks App env-shape detection).
- `appkit` - generic AppKit runtime: `WorkspaceClientLike` /
  `ExecutionContextLike` types, `tryGetExecutionContext`, `ensureInitialized`.
- `plugin` - typed AppKit plugin lookup: `data` / `instance` / `require`.
- `config` - layered config resolution (`resolveConfigValue`) over `env`,
  Databricks Asset Bundle validate JSON, and `app.yaml` env entries.
- `createApp` - a drop-in for AppKit's `createApp` that runs auto-config first
  (`autoConfigure`), plus `lakebaseResolver` / `pgaddress` / `provision`:
  resolve a Lakebase Postgres connection (env / config / Lakebase Autoscaling
  REST) and grant the AppKit cache schema before the app boots.

Deps: `@databricks/appkit` (optional peer for `appkit`/`plugin`/`createApp`),
`@databricks/sdk-experimental`, zod + `yaml` (for `config`), and
[`@dbx-tools/node-core`](../core) for project-root discovery. The `appkit-env`
CLI that fronts `createApp.autoConfigure` lives in
[`@dbx-tools/appkit-env`](../../cli/appkit-env).
