# @dbx-tools/appkit

Node-side helpers for Databricks AppKit apps.

Import this package when backend code needs AppKit execution context, typed
plugin lookup, Databricks SDK cancellation, or Lakebase auto-configuration
without taking on a heavier feature package.

**Key features:**

- Auto-configuration before AppKit setup, especially for Lakebase/Postgres env
  values that AppKit plugins read during initialization.
- Runtime-safe context access for code that may run inside an AppKit request,
  from a CLI, or from a background script.
- Typed plugin lookup helpers for AppKit plugins that depend on exports from
  sibling plugins.
- Lakebase resolution through the shared `@dbx-tools/core` configuration path,
  including local env, bundle, and `app.yaml` sources.
- SDK cancellation bridging from web `AbortSignal` values into Databricks SDK
  `Context` values.
- Lakebase cache-schema provisioning for deployments where the app identity must
  be granted access before persistent cache initialization.
- An interceptor context on `createApp` (`interceptor?: Interceptor | Interceptor[]`)
  that hands add-ons the computed env, AppKit lifecycle hooks (`onLifecycle`, using
  AppKit's own `setup:complete` / `server:ready` / `shutdown` vocabulary), signal
  broadcast, and `bindProcess` for concurrently-style child supervision - any
  bound process's death tears the app down, signals pass through. `@dbx-tools/tunnel`
  is the primary consumer.

## Why Use This Over Native AppKit

Use native AppKit directly when your app can read its required env vars before
`createApp()` and does not need extra setup around plugin exports or config
sources.

Use this package when the friction is around bootstrapping and reuse:

- AppKit plugins read Lakebase/Postgres env during initialization; this package
  resolves and applies those values before setup.
- AppKit exposes request context inside AppKit handlers; these helpers make code
  safe to call from scripts, tests, and background jobs too.
- AppKit plugin instances are generic; the lookup helpers keep sibling-plugin
  access typed and errors actionable.
- AppKit does not own your local CLI flags, bundle validation output, or
  `app.yaml`; `@dbx-tools/core` centralizes those sources for this package and
  other Node callers.
- AppKit's `asUser(req)` throws outside `NODE_ENV=development` when a request
  carries no OBO token; `identity` makes falling back to the service principal a
  configured, per-request decision instead of a `NODE_ENV` side effect.

## Create An Auto-Configured App

`appkit.createApp` is a drop-in wrapper around AppKit `createApp` with the
same config and the same typed plugin-export map. It runs
`appkit.autoConfigure()` first so enabled capabilities can populate
environment variables before plugin setup runs.

```ts
import { lakebase, server } from "@databricks/appkit";
import { appkit } from "@dbx-tools/appkit";

await appkit.createApp({
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

Boot-time resolution runs as the service principal before any plugin exists, so
it sits outside AppKit's interceptor chain. It carries its own timeout, and
`appkit.autoConfigure()` accepts an `AbortSignal` when a caller wants to
cancel it earlier.

Use the lower-level functions when you need to inspect or customize the result:

```ts
import { lakebaseResolver } from "@dbx-tools/appkit";

const resolved = await lakebaseResolver.resolveLakebaseConnection({
  endpoint: process.env.LAKEBASE_ENDPOINT,
  autoCreate: false,
});

lakebaseResolver.applyLakebaseToEnv(resolved);
```

`applyLakebaseEnv()` does both steps and applies the COMPLETE set a Postgres pool
needs, `PGUSER` included — it is what auto-configuration itself calls, so a caller
outside `createApp` gets the same env rather than a hand-rolled subset:

```ts
const { resolved, user } = await lakebaseResolver.applyLakebaseEnv({ autoCreate: false });
```

Reach for it when something other than the `lakebase()` plugin needs a working
pool. AppKit's PERSISTENT cache is the common case: it builds its own pool from
env, and `createLakebasePool()` throws unless `LAKEBASE_ENDPOINT`, `PGHOST`,
`PGDATABASE`, and a username are all present — while a Databricks App `postgres`
resource binding supplies only the first. Miss one and the cache degrades silently
to in-memory. `@dbx-tools/tunnel`'s OTP gate calls this for exactly that
reason.

## Configuration

`appkit.createApp()` accepts everything AppKit's `createApp` does, plus:

| Option          | Type                            | Default       | Description                                                                                                                                                                                                                                                                                                                 |
| --------------- | ------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `autoConfigure` | `"provision" \| "env" \| false` | `"provision"` | What to run before AppKit boots. `"provision"` resolves the Lakebase connection into `process.env` and grants the AppKit cache schema; `"env"` resolves the connection only; `false` skips auto-configuration. Omit it to gate the default on a `lakebase` plugin being registered, or set it explicitly to run regardless. |
| `interceptor`   | `Interceptor \| Interceptor[]`  | none          | One or many callbacks handed an `InterceptorContext` after auto-config computes the env and before AppKit boots. The context carries the resolved env, `onLifecycle` (AppKit's `setup:complete` / `server:ready` / `shutdown`), `broadcastSignal`, and `bindProcess` for concurrently-style child supervision.              |

Set `autoConfigure` explicitly on an app that registers no `lakebase()` plugin but
still wants AppKit's PERSISTENT cache. AppKit only chooses Lakebase for
`CacheManager` when it can build a pool, and that reads `LAKEBASE_ENDPOINT`,
`PGHOST`, and `PGDATABASE` from `process.env` — while a Databricks App `postgres`
resource binding supplies only the first. Without the resolution step the cache
degrades silently to in-memory, so anything it holds (a session signing key, a
one-time code) is lost on every restart. `"env"` is the right mode inside a
deployed app, since the app service principal cannot grant on the cache schema
anyway.

`lakebaseResolver.resolveLakebaseConnection()` accepts:

| Option       | Type                                 | Default                                  | Description                                                                                                    |
| ------------ | ------------------------------------ | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `endpoint`   | `string`                             | `LAKEBASE_ENDPOINT`                      | Any address `pgaddress.parseAddress()` understands: resource path, Postgres URI, hostname, or bare project id. |
| `project`    | `string`                             | discovered                               | Lakebase project id. Resolved from the workspace when unset.                                                   |
| `branch`     | `string`                             | project default                          | Branch id within the project.                                                                                  |
| `database`   | `string`                             | `PGDATABASE`, else `databricks_postgres` | Postgres database name.                                                                                        |
| `host`       | `string`                             | `PGHOST`, else the endpoint's host       | Postgres hostname.                                                                                             |
| `port`       | `number`                             | `PGPORT`, else `5432`                    | Postgres port.                                                                                                 |
| `sslMode`    | `"require" \| "disable" \| "prefer"` | `PGSSLMODE`, else `require`              | Postgres TLS mode.                                                                                             |
| `autoCreate` | `string \| false`                    | slug of the package name                 | Project id to create when the workspace has none. `false` fails instead of creating.                           |

Environment variables read during resolution:

| Variable            | Description                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| `LAKEBASE_ENDPOINT` | Endpoint resource path, Postgres URI, hostname, or project id.                                   |
| `PGHOST`            | Postgres hostname. Skips the endpoint lookup when set with `PGDATABASE` and `LAKEBASE_ENDPOINT`. |
| `PGDATABASE`        | Postgres database name.                                                                          |
| `PGPORT`            | Postgres port. A value outside 1-65535 fails with a `ValidationError`.                           |
| `PGSSLMODE`         | `require`, `disable`, or `prefer`. Any other value fails with a `ValidationError`.               |
| `PGUSER`            | Connecting role. Filled from the workspace identity when unset.                                  |

Resolved values are written back to `process.env` by
`lakebaseResolver.applyLakebaseToEnv()`, which never overwrites a variable that
is already set. That function covers everything except `PGUSER`, which needs an
await; `lakebaseResolver.applyLakebaseEnv()` resolves and applies the full set.

## Resolve Local And Bundle Config

Configuration is owned by `@dbx-tools/core`, not re-exported by this package.
Its default precedence is constant config, process env, `.env`, bundle
`config.env`, then `app.yaml` / `app.yml`.

```ts
import { config } from "@dbx-tools/core";

const warehouseId = config.resolveValue("DATABRICKS_WAREHOUSE_ID", {
  data: { DATABRICKS_WAREHOUSE_ID: flags.warehouse },
});
```

Use this in CLIs and setup scripts that should behave the same locally and in a
Databricks App deployment. `config.bundleFile()` exposes validated bundle
output, while `config.appFile()` exposes parsed App YAML. Both cache successful,
missing, and invalid results for the process lifetime.

## Parse Lakebase Addresses

`pgaddress.parseAddress()` accepts resource paths, Postgres URLs, bare
Lakebase hosts, and partial inputs. It gives the resolver a common shape without
requiring users to remember one canonical format.

```ts
import { pgaddress } from "@dbx-tools/appkit";

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
import { appkit } from "@dbx-tools/appkit";
import { WorkspaceClient } from "@databricks/sdk-experimental";

const client = appkit.tryGetExecutionContext()?.client ?? new WorkspaceClient({});
```

`appkit.ensureInitialized()` lazily initializes AppKit runtime state before
context lookup in code paths that may run early.

## Adapt Databricks SDK Cancellation

Databricks SDK calls accept a `Context`. Many app and web APIs use
`AbortSignal`. `databricks.toContext()` bridges the two.

```ts
import { databricks } from "@dbx-tools/appkit";

await client.apiClient.request(
  {
    path: "/api/2.0/serving-endpoints",
    method: "GET",
    headers: new Headers(),
    raw: false,
  },
  databricks.toContext(request.signal),
);
```

## Look Up Sibling Plugins

AppKit's plugin map is intentionally generic. `plugin.data()`,
`plugin.instance()`, and `plugin.require()` keep lookups typed and produce better
errors when a required plugin is missing.

```ts
import { lakebase } from "@databricks/appkit";
import { plugin } from "@dbx-tools/appkit";

const lake = plugin.instance(this.context, lakebase);
const pool = lake?.exports().pool;

const required = plugin.require(this.context, lakebase, "my-plugin").exports();
```

Use this in AppKit plugins that depend on sibling plugin exports but should not
hard-code registered names or casts at every call site. A missing required
plugin throws AppKit's `ConfigurationError`, naming both the caller and the
plugin to register.

## Provision Lakebase Cache Schema

`provision.provisionCacheSchema()` grants the AppKit cache schema in Lakebase to
the Postgres role that will run the app. Use it after Lakebase connection env has
been resolved and before AppKit initializes its persistent cache.

```ts
import { provision } from "@dbx-tools/appkit";

await provision.provisionCacheSchema("app-service-principal@databricks.com");
```

Pass a second argument to report progress on your own logger. The grants are
skipped inside a Databricks App, and any failure is logged rather than thrown so
a degraded cache never blocks startup.

## Choose The Request Identity

AppKit gives a plugin two identities: the ambient service context (the app's own
service principal) and a per-request user context entered with `asUser(req)`,
which authenticates on-behalf-of (OBO) using the token the Databricks front door
forwards on `x-forwarded-access-token`. When that header is absent, AppKit's
behaviour depends entirely on `NODE_ENV`:

| `NODE_ENV`    | `asUser(req)` with no `x-forwarded-access-token`       |
| ------------- | ------------------------------------------------------ |
| `development` | logs a warning, silently runs as the service principal |
| anything else | throws `AuthenticationError: Missing user token`       |

That throw is right for an app behind the front door, where a missing token means
something is broken. It is fatal for an app whose traffic legitimately arrives
without one - a public tunnel where callers authenticate by email code
([`@dbx-tools/tunnel`](../../node/tunnel)), or a bot channel that validates its
own inbound JWT (`POST /api/teams/messages`). Those apps must not run with
`NODE_ENV=development` just to get the fallback, since that flag also relaxes
secure cookies and unlocks other dev-only escape hatches.

`identity` is that decision, made explicit:

```ts
import { identity } from "@dbx-tools/appkit";

const mode = identity.resolveIdentityMode(config.identity, "MY_APP_IDENTITY");

// One call decides whether this request enters `asUser`.
const scoped = identity.useServicePrincipal(mode, req) ? this : this.asUser(req);
const rows = await scoped.executeQuery(sql);
```

| Mode                | Behaviour                                                                    |
| ------------------- | ---------------------------------------------------------------------------- |
| `user` (default)    | Always OBO. Per-user attribution and per-user Genie / Unity Catalog filters. |
| `service-principal` | Always the app's own identity. Needs no OBO scopes and serves any caller.    |
| `auto`              | OBO when the request carries a usable token, service principal otherwise.    |

`auto` decides per REQUEST, not per boot, because one container can serve both
doors at once - the tunnel gate and the platform front door share a port. A
boot-time flag would have to be wrong for one of them. An unrecognized configured
value throws a `ConfigurationError` rather than falling back, because a typo
(`"obo"`, `"sp"`) would otherwise keep serving the very error the option was set
to avoid.

Running as the service principal does not change WHO the request belongs to. The
caller still arrives on `x-forwarded-user` / `x-forwarded-email` (read them with
`identity.requestUserId()` / `requestUserEmail()`), so memory threads, cache
namespaces, and trace attribution stay per-user - only the Databricks credential
is shared. `@dbx-tools/appkit-mastra` exposes this as its `genieIdentity` option.

## Modules

| Module             | Responsibility                                                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `appkit`           | `createApp()` / `autoConfigure()`, plus execution context lookup and initialization.                                                            |
| `lakebaseResolver` | Lakebase connection discovery, default picking, optional auto-create, and env application (`applyLakebaseEnv()` for the full set a pool needs). |
| `pgaddress`        | Permissive Lakebase/Postgres address parser.                                                                                                    |
| `config`           | Local/env/bundle/app-yaml config lookup.                                                                                                        |
| `databricks`       | App env detection and SDK context cancellation adapters.                                                                                        |
| `plugin`           | Typed AppKit plugin data, instance, and required-instance lookup.                                                                               |
| `provision`        | Cache schema provisioning helpers.                                                                                                              |
| `identity`         | OBO-vs-service-principal request identity: modes, resolution, and the forwarded headers.                                                        |

The shell-facing wrapper for auto-config is
[`@dbx-tools/cli-appkit-env`](../../cli/appkit-env). Higher-level agent composition
is in [`@dbx-tools/appkit-mastra`](../appkit-mastra).
