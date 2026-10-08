# @dbx-tools/shared-graphiti

Use the browser-safe Graphiti option contract from Node, AppKit, browser tools,
or other JavaScript callers. This package owns defaults, validation, and
environment parsing so every Node runtime accepts the same configuration.

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

Zod schemas own runtime validation and inferred input/output types. Process
launching, Databricks authentication, model discovery, and service lifecycle
remain with their Node and CLI owners.
