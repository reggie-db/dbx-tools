# `@dbx-tools/appkit-graphiti`

Run Graphiti as an AppKit plugin or supervise the same Python runtime directly
from Node. The package root exposes the plugin; the `runtime` and `options`
subpaths expose the underlying lifecycle and configuration contracts.

## Start And Stop Graphiti

Build and start the sidecar with the same shared options used by the CLI and AppKit:

```ts
import { createGraphitiChildProcess } from "@dbx-tools/appkit-graphiti/runtime";

const sidecar = await createGraphitiChildProcess({
  profile: "MY-PROFILE",
  modelClass: "chat-fast",
});

await sidecar.start();
await sidecar.shutdown();
```

`createGraphitiChildProcess({ healthCheck })` accepts an
`AppKitChildProcessHealthCheck`. By default it polls Graphiti's `/healthcheck`
endpoint. The AppKit plugin supplies an OpenAPI probe so tool registration can
use the same non-empty `/openapi.json` document that established startup, then
polls `/healthcheck` with the remaining startup budget. Every tool call awaits
that healthcheck promise, and AppKit is SIGTERMed if the later probe fails.

Set `bearer` or `GRAPHITI_TOKEN` to require bearer authentication on every
Graphiti HTTP endpoint. The AppKit plugin generates a fresh bearer for each
sidecar run and includes it in all private requests automatically.

Set `PYTHON` to launch that interpreter directly. Without it, the runtime uses
`uv run` to provision the matching `dbx-tools-graphiti` package. Set
`DBX_TOOLS_NODE_BIN` to prepend a specific Node executable's directory for
Python and its descendants.

Calling `shutdown()` forwards SIGTERM, allows bounded Python cleanup, and
escalates the process tree only when graceful shutdown exceeds its deadline.

## Run Until Exit

Use the foreground helper when another Node entry point owns signal handling:

```ts
import { runGraphiti } from "@dbx-tools/appkit-graphiti/runtime";

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
import { graphiti } from "@dbx-tools/appkit-graphiti";

export default {
  plugins: [graphiti({ profile: "MY-PROFILE" })],
};
```

The package root owns sidecar startup, OpenAPI-derived tool registration,
per-user graph scopes, and the exported `GRAPHITI_CONFIG_SCHEMA`.

The model-facing `add_memory` tool executes Graphiti's synchronous write
operation, so a successful tool result means extraction and PostgreSQL
persistence completed. The direct HTTP surface retains the upstream
fire-and-forget operation for callers that intentionally manage queued writes.

Run the manual smoke tiers separately from routine tests:

```bash
bun run graphiti:smoke:embedded
bun run graphiti:smoke:mastra --profile MY-PROFILE
```

The embedded smoke test covers PostGraph CRUD, full-text search, shutdown, and
restart persistence. The Mastra smoke test starts the AppKit plugin on an
automatically selected loopback port, writes through the model-facing tool,
restarts the embedded database, and verifies retrieval through the same tool
provider path used by Mastra agents.
