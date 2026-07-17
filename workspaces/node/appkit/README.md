# @dbx-tools/node-appkit

Node-side helpers for Databricks AppKit apps.

Import this package when backend code needs AppKit execution context, typed
plugin lookup, Databricks SDK cancellation, layered config resolution, or
Lakebase auto-configuration without taking on a heavier feature package.

Key features:

- Auto-configuration before AppKit setup, especially for Lakebase/Postgres env
  values that AppKit plugins read during initialization.
- Runtime-safe context access for code that may run inside an AppKit request,
  from a CLI, or from a background script.
- Typed plugin lookup helpers for AppKit plugins that depend on exports from
  sibling plugins.
- Config resolution across explicit options, CLI flags, env vars, Databricks
  Asset Bundle outputs, and `app.yaml`.
- SDK cancellation bridging from web `AbortSignal` values into Databricks SDK
  `Context` values.
- Lakebase cache-schema provisioning for deployments where the app identity must
  be granted access before persistent cache initialization.

## Create An Auto-Configured App

`createApp.createApp` is a drop-in wrapper around AppKit `createApp`. It runs
`createApp.autoConfigure()` first so enabled capabilities can populate
environment variables before plugin setup runs.

```ts
import { lakebase, server } from "@databricks/appkit";
import { createApp } from "@dbx-tools/node-appkit";

await createApp.createApp({
  plugins: [server(), lakebase()],
});
```

When `lakebase()` is present, auto-config resolves Lakebase Postgres connection
settings and fills missing `PG*` / `LAKEBASE_*` variables. That avoids a startup
race where the Lakebase plugin reads env before another async setup step can
discover it.

Auto-configuration is conservative: existing env vars win unless a caller passes
explicit options, and local-only discovery is skipped inside a Databricks App
environment. This makes the same entrypoint usable in local development,
Databricks Asset Bundle validation, and deployed Apps.

Use the lower-level functions when you need to inspect or customize the result:

```ts
import { lakebaseResolver } from "@dbx-tools/node-appkit";

const resolved = await lakebaseResolver.resolveLakebaseConnection({
  endpoint: process.env.LAKEBASE_ENDPOINT,
  autoCreate: false,
});

lakebaseResolver.applyLakebaseToEnv(resolved);
```

## Resolve Local And Bundle Config

`config.resolveConfigValue()` checks explicit options, CLI overrides, env vars,
Databricks Asset Bundle validation output, and `app.yaml` env entries.

```ts
import { config } from "@dbx-tools/node-appkit";

const warehouseId = await config.resolveConfigValue("SQL_WAREHOUSE_ID", {
  cli: { SQL_WAREHOUSE_ID: flags.warehouse },
  sources: config.withCliSources(),
});
```

Use this in CLIs and setup scripts that should behave the same locally and in a
Databricks App deployment. `config.bundle()` and `config.appYaml()` expose the
parsed files when you need to diagnose which source won.

## Parse Lakebase Addresses

`pgaddress.parseAddress()` accepts resource paths, Postgres URLs, bare
Lakebase hosts, and partial inputs. It gives the resolver a common shape without
requiring users to remember one canonical format.

```ts
import { pgaddress } from "@dbx-tools/node-appkit";

pgaddress.parseAddress(
  "postgresql://user@ep-foo.database.azuredatabricks.net/databricks_postgres?sslmode=require",
);
```

`pgaddress.parseResourcePath()` is useful when you specifically expect a
`projects/<id>/branches/<id>/endpoints/<id>` value.

## Use AppKit Execution Context Safely

`appkit.tryGetExecutionContext()` returns the active AppKit request context when
code is running under AppKit, and `undefined` elsewhere. That lets libraries
preserve OBO auth in apps while still working from scripts.

```ts
import { appkit } from "@dbx-tools/node-appkit";
import { WorkspaceClient } from "@databricks/sdk-experimental";

const client = appkit.tryGetExecutionContext()?.client ?? new WorkspaceClient({});
```

`appkit.ensureInitialized()` lazily initializes AppKit runtime state before
context lookup in code paths that may run early.

## Adapt Databricks SDK Cancellation

Databricks SDK calls accept a `Context`. Many app and web APIs use
`AbortSignal`. `databricks.toContext()` bridges the two.

```ts
import { databricks } from "@dbx-tools/node-appkit";

const context = databricks.toContext(request.signal);
await client.apiClient.request({
  path: "/api/2.0/serving-endpoints",
  method: "GET",
  headers: new Headers(),
  raw: false,
  context,
});
```

`databricks.isAppEnv()` checks the Databricks App environment shape for setup
code that should skip local-only filesystem or bundle discovery.

## Look Up Sibling Plugins

AppKit's plugin map is intentionally generic. `plugin.data()`,
`plugin.instance()`, and `plugin.require()` keep lookups typed and produce better
errors when a required plugin is missing.

```ts
import { lakebase } from "@databricks/appkit";
import { plugin } from "@dbx-tools/node-appkit";

const lake = plugin.instance(this.context, lakebase);
const pool = lake?.exports().pool;

const required = plugin.require(this.context, lakebase, "my-plugin").exports();
```

Use this in AppKit plugins that depend on sibling plugin exports but should not
hard-code registered names or casts at every call site.

## Provision Lakebase Cache Schema

`provision.provisionCacheSchema()` grants the AppKit cache schema in Lakebase to
the Postgres role that will run the app. Use it after Lakebase connection env has
been resolved and before AppKit initializes its persistent cache.

```ts
import { provision } from "@dbx-tools/node-appkit";
import { log } from "@dbx-tools/shared-core";

await provision.provisionCacheSchema(
  log.logger("appkit-cache"),
  "app-service-principal@databricks.com",
);
```

## Modules

- `createApp` - `createApp()` wrapper and `autoConfigure()`.
- `lakebaseResolver` - Lakebase connection discovery, default picking, optional
  auto-create, and env application.
- `pgaddress` - permissive Lakebase/Postgres address parser.
- `config` - local/env/bundle/app-yaml config lookup.
- `appkit` - execution context lookup and initialization.
- `databricks` - App env detection and SDK context cancellation adapters.
- `plugin` - typed AppKit plugin data, instance, and required-instance lookup.
- `provision` - cache schema provisioning helpers.

The shell-facing wrapper for auto-config is
[`@dbx-tools/appkit-env`](../../cli/appkit-env). Higher-level agent composition
is in [`@dbx-tools/node-appkit-mastra`](../appkit-mastra).
