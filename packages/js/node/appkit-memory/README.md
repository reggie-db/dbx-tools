# `@dbx-tools/appkit-memory`

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

`memory()` publishes two tools:

- `remember` saves content at a stable absolute path.
- `recall_memory` searches durable memory for the current actor.

A 403 or 404 from the Databricks store selects Graphiti. Other Databricks
errors propagate so a transient outage does not split one actor's memory
between backends.

`databricks` defaults to `"auto"`. Set it to `true` to require managed-memory
access for every caller or `false` to disable the managed backend. The object
form accepts `memoryStore` and `mode: "auto" | "required"`.

## Use with Mastra

Request the toolkit from an agent:

```ts
import { agents, mastra } from "@dbx-tools/appkit-mastra";

const support = agents.createAgent({
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

## Graphiti runtime

The Graphiti fallback is imported and started on the first operation that needs
it. Concurrent first operations share one startup. Configure `PYTHON` to use an
installed runtime or let the package provision the matching Python package
through `uv`.

Standalone Graphiti callers and the dbx CLI use the public subpath:

```ts
import { runtime as graphiti } from "@dbx-tools/appkit-memory/graphiti";

await graphiti.runGraphiti({ profile: "MY-PROFILE" });
```

# replace this
