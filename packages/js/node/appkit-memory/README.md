# @dbx-tools/appkit-memory

Add durable, actor-scoped memory tools to an AppKit application. The plugin
checks Databricks Agent Memory first and starts its Graphiti sidecar only when
the current actor cannot access the configured managed-memory store.

## Register the plugin

```ts
import { createApp, server } from "@databricks/appkit";
import { memory } from "@dbx-tools/appkit-memory";

await createApp({
  plugins: [
    server(),
    memory({
      databricks: { memoryStore: "support-memory" },
      graphiti: { modelClass: "chat-fast" },
    }),
  ],
});
```

The plugin is beta. It publishes two tools:

- `remember` saves non-empty content at a stable absolute path, such as
  `/preferences/response.md`.
- `recall_memory` searches memory for the current actor and returns up to 100
  results.

A 403 or 404 from the Databricks store selects Graphiti. Other Databricks
errors remain errors, which prevents a transient outage from splitting one
actor's memory between backends.

`databricks` defaults to `"auto"`. Set it to `true` to require managed-memory
access for every caller or `false` to disable the managed backend. The object
form accepts `memoryStore` and `mode: "auto" | "required"`.

## Add the tools to a Mastra agent

Request the toolkit from an agent:

```ts
import { createApp, server } from "@databricks/appkit";
import { agents, mastra } from "@dbx-tools/appkit-mastra";
import { memory } from "@dbx-tools/appkit-memory";

const support = agents.createAgent({
  name: "Support",
  instructions: "Help the user.",
  async tools(plugins) {
    return (await plugins.memory?.toolkit()) ?? {};
  },
});

await createApp({
  plugins: [server(), mastra({ agents: { support } }), memory()],
});
```

Mastra continues to store threads and messages in its configured
`PostgresStore` and semantic recall in `PgVector`. `saveTurns` defaults to
`"auto"`, which attaches the memory plugin's output processor when both Mastra
and Graphiti are registered. Set it to `true` to require attachment at startup
or `false` to disable it. Completed turns are mirrored to Graphiti only when
Databricks managed memory is unavailable. Managed-memory session extraction is
not used.

## Configure the backends

`memory()` accepts the following backend and turn-saving settings:

| Option                   | Default                    | Behavior                                                                                                                                  |
| ------------------------ | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `databricks`             | `"auto"`                   | Uses Databricks managed memory when the actor can access the store. A 403 or 404 selects Graphiti.                                        |
| `databricks.memoryStore` | Project-derived store name | Selects an existing memory store by ID or resource name.                                                                                  |
| `databricks.mode`        | `"auto"`                   | Set to `"required"` to fail instead of selecting Graphiti.                                                                                |
| `graphiti`               | `true`                     | Enables the lazy Graphiti fallback. Pass a Graphiti options object to override its model, database, listener, or authentication settings. |
| `saveTurns`              | `"auto"`                   | Attaches a Mastra output processor when Mastra and Graphiti are registered.                                                               |

At least one backend must remain enabled. `saveTurns: true` requires both a
registered Mastra plugin and the Graphiti backend. `databricks: true` requires
managed-memory access for every caller.

## Run Graphiti directly

The Graphiti fallback is imported and started on the first operation that needs
it. Concurrent first operations share one startup. Configure `PYTHON` to use an
installed runtime or let the package provision the matching Python package
through `uv`.

Standalone Graphiti callers and the dbx CLI use the public subpath:

```ts
import { runtime as graphiti } from "@dbx-tools/appkit-memory/graphiti";

await graphiti.runGraphiti({ profile: "MY-PROFILE" });
```

`runGraphiti()` blocks until the process exits. Use it for a standalone
Graphiti server or CLI integration. AppKit applications don't need to call it
because the plugin supervises the fallback process.

## Understand memory limits

- Memory is partitioned by the trusted AppKit request identity. An `actor_id`
  is a storage key, not an authorization mechanism.
- Graphiti starts only after an operation cannot use Databricks managed memory.
  Registering the plugin doesn't start Python or PostgreSQL.
- The plugin stops a Graphiti process that it started when AppKit shuts down.
- Mastra thread storage and PgVector semantic recall remain separate from these
  durable memory tools.
- Graphiti needs either a PostgreSQL or Lakebase database URL, or the optional
  embedded PostgreSQL runtime.

For Graphiti server, database, and queue behavior, see
[dbx-tools-graphiti](../../../py/graphiti/README.md).
