# @dbx-tools/node-appkit

Node-side Databricks + AppKit glue, so the browser-safe
[`@dbx-tools/shared-core`](../../shared/core) stays SDK-free. Three modules with
clear scopes:

```ts
import { databricks, appkit, plugin } from "@dbx-tools/node-appkit";

const ctx = databricks.toContext(controller, options.context); // SDK cancellation
const client = appkit.tryGetExecutionContext()?.client;        // OBO workspace client
const lake = plugin.instance(this.context, lakebase);          // sibling plugin lookup
```

## Modules

- `databricks` - generic Databricks SDK glue (no AppKit): the
  `Context`/`AbortSignal` cancellation adapter (`toContext`, `ContextLike`) and
  `isAppEnv` (Databricks App env-shape detection). `@databricks/sdk-experimental`
  is a runtime dep.
- `appkit` - generic AppKit runtime: `WorkspaceClientLike` /
  `ExecutionContextLike` types, `tryGetExecutionContext`, `ensureInitialized`.
- `plugin` - typed AppKit plugin lookup: `data` / `instance` / `require`.

`@databricks/appkit` is an optional peer (only `appkit` / `plugin` need it;
`databricks` consumers needn't install it).
