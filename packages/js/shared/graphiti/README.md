# @dbx-tools/shared-graphiti

Use the same browser-safe Graphiti options from Node, AppKit, browser tools, and
other JavaScript callers. The package applies defaults, validates values, and
parses environment-shaped records.

## Resolve Runtime Options

```ts
import { resolveGraphitiOptions } from "@dbx-tools/shared-graphiti/options";

const options = resolveGraphitiOptions({
  profile: "MY-PROFILE",
  modelClass: "chat-fast",
});
```

The result includes stable listener, chat-class, database durability, and
structured-output defaults. Embedding selection and dimensions come from live
model metadata. Route and embedded-process details are intentionally not part
of this browser-safe contract.

## Parse Environment Options

Resolve supported environment names without reading global process state:

```ts
import { graphitiOptionsFromEnvironment } from "@dbx-tools/shared-graphiti/options";

const options = graphitiOptionsFromEnvironment({
  DATABRICKS_CONFIG_PROFILE: "MY-PROFILE",
  GRAPHITI_LISTEN: "tcp://127.0.0.1:7272",
  GRAPHITI_HOME: "/var/lib/agent-memory",
});
```

Zod schemas provide runtime validation and inferred input/output types. Process
launching, Databricks authentication, model discovery, and service lifecycle are
handled by the Node integration.
