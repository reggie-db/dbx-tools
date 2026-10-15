# @dbx-tools/shared-graphiti

Validate Graphiti configuration consistently in Node, Databricks AppKit,
browser tools, and shared JavaScript code. Use the browser-safe schemas,
defaults, and environment parser without loading the Graphiti runtime.

## Resolve runtime options

```ts
import { resolveGraphitiOptions } from "@dbx-tools/shared-graphiti/options";

const options = resolveGraphitiOptions({
  profile: "MY-PROFILE",
  modelClass: "chat-fast",
});
```

The result includes listener, chat model class, database durability, and
structured-output defaults. The server integration derives embedding selection
and dimensions from live model metadata.

## Parse environment options

Resolve supported environment names without reading global process state:

```ts
import { graphitiOptionsFromEnvironment } from "@dbx-tools/shared-graphiti/options";

const options = graphitiOptionsFromEnvironment({
  DATABRICKS_CONFIG_PROFILE: "MY-PROFILE",
  GRAPHITI_LISTEN: "tcp://127.0.0.1:7272",
  GRAPHITI_HOME: "/var/lib/agent-memory",
});
```

The parser accepts an explicit record and doesn't read global process state.
Supported fields include the Databricks profile, bearer token, listener,
runtime directory, model class, database URL, database schema, and startup
timeout.

## Runtime boundary

This package doesn't launch Graphiti, read credentials, discover models, or
manage a database. The
[@dbx-tools/appkit-memory](../../node/appkit-memory) server plugin owns
authentication, lazy Graphiti startup, and service lifecycle.

## Package exports

- `./options`: option schemas, defaults, explicit environment parsing, and
  process-environment serialization.
