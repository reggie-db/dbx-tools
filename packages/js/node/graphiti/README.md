# `@dbx-tools/graphiti`

Run Graphiti from Node without coupling lifecycle control to a CLI or AppKit
plugin. Callers provide the shared typed Graphiti options and receive one
runtime handle for completion and shutdown.

## Start And Stop Graphiti

Start the runtime with the same shared options used by the CLI and AppKit:

```ts
import { startGraphitiRuntime } from "@dbx-tools/graphiti/runtime";

const runtime = await startGraphitiRuntime({
  profile: "MY-PROFILE",
  model: "gpt 5",
  embedderModel: "gte large",
});

await runtime.stop();
```

Use `graphitiOpenApi()` to read the Python-owned API contract without starting
the database runtime. AppKit uses this to register direct tools before the
sidecar warms.

`runtime.result` resolves when the supervised runtime exits. Calling `stop()`
forwards SIGTERM, allows bounded Python cleanup, and escalates the process group
only when graceful shutdown exceeds its deadline.

## Run Until Exit

Use the foreground helper when another Node entry point owns signal handling:

```ts
import { runGraphiti } from "@dbx-tools/graphiti/runtime";

await runGraphiti({ profile: "MY-PROFILE" });
```

Model selection, route resolution, authentication refresh, process supervision,
PostGraph client lifecycle, and embedded PostgreSQL lifecycle remain internal
to the runtime. Omit `databaseUrl` to persist bundled PostgreSQL beneath
`graphitiHome`. A configured PostgreSQL URL or Lakebase target uses the external
database instead.

Set `postgresRole` or `DBX_TOOLS_POSTGRES_ROLE` when Graphiti should use the
shared PostgreSQL assumed-role policy. The login identity must already have
permission to `SET ROLE` to that role.

## Embed The Runtime

Use this package from Node applications that need Graphiti lifecycle control.
Use `@dbx-tools/cli/graphiti` for Commander and desktop-service commands.

## Register With AppKit

```ts
import { graphiti } from "@dbx-tools/graphiti/appkit";

export default {
  plugins: [graphiti({ profile: "MY-PROFILE" })],
};
```

The AppKit subpath owns sidecar startup, OpenAPI-derived tool registration, and
per-user graph scopes. Its configuration schema is available from
`@dbx-tools/graphiti/appkit/config`.
