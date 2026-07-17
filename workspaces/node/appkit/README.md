# @dbx-tools/node-appkit

Node-side Databricks + AppKit glue, so the browser-safe
[`@dbx-tools/shared-core`](../../shared/core) stays SDK-free. Four modules with
clear scopes:

```ts
import { databricks, appkit, plugin, config } from "@dbx-tools/node-appkit";

const ctx = databricks.toContext(controller, options.context); // SDK cancellation
const client = appkit.tryGetExecutionContext()?.client;        // OBO workspace client
const lake = plugin.instance(this.context, lakebase);          // sibling plugin lookup
const warehouse = await config.resolveConfigValue("SQL_WAREHOUSE_ID"); // env/bundle
```

## Modules

- `databricks` - generic Databricks SDK glue (no AppKit): the
  `Context`/`AbortSignal` cancellation adapter (`toContext`, `ContextLike`) and
  `isAppEnv` (Databricks App env-shape detection). `@databricks/sdk-experimental`
  is a runtime dep.
- `appkit` - generic AppKit runtime: `WorkspaceClientLike` /
  `ExecutionContextLike` types, `tryGetExecutionContext`, `ensureInitialized`.
- `plugin` - typed AppKit plugin lookup: `data` / `instance` / `require`.
- `config` - layered config resolution (`resolveConfigValue`) over `env`,
  Databricks Asset Bundle validate JSON, and `app.yaml` env entries.

`@databricks/appkit` is an optional peer (only `appkit` / `plugin` need it;
`databricks` / `config` consumers needn't install it).
