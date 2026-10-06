# @dbx-tools/shared-graphiti

Use the browser-safe Graphiti option contract from Node, AppKit, browser tools,
or generated language bindings. This package owns defaults, validation,
environment parsing, and model-gateway ownership rules so every runtime accepts
the same configuration.

## Resolve Runtime Options

```ts
import { resolveGraphitiOptions } from "@dbx-tools/shared-graphiti/options";

const options = resolveGraphitiOptions({
  profile: "MY-PROFILE",
  model: "gpt 5",
  embedderModel: "gte large",
});
```

The result includes stable listener, model, embedding, gateway, and structured
output defaults. Supplying `modelGatewayUrl` selects an existing gateway unless
`manageModelGateway` explicitly opts back into local ownership.

## Serialize A Child Runtime

Use the shared serializer when a Node host starts the Python Graphiti runtime:

```ts
import {
  GRAPHITI_OPTIONS_ENV,
  serializeGraphitiOptions,
} from "@dbx-tools/shared-graphiti/options";

const environment = {
  [GRAPHITI_OPTIONS_ENV]: serializeGraphitiOptions({
    profile: "MY-PROFILE",
    journalNamespace: "agent-memory",
  }),
};
```

The Python binding consumes this exact validated record. Do not add parallel
environment parsing or option types in a CLI, AppKit plugin, or language
runtime.

## Build Provider Environment

Use `graphitiEnvironment` to derive the OpenAI-compatible variables expected by
Graphiti without duplicating model, embedding, key, or structured-output
mapping:

```ts
import { graphitiEnvironment } from "@dbx-tools/shared-graphiti/options";

const environment = graphitiEnvironment({
  modelGatewayUrl: "http://127.0.0.1:4000/v1",
  manageModelGateway: false,
  model: "databricks-gpt-5",
});
```

Zod schemas own runtime validation and inferred input/output types. Process
launching, Databricks authentication, model discovery, and service lifecycle
remain with their Node and CLI owners.
