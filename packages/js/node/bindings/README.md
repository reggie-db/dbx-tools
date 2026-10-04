# `@dbx-tools/bindings`

Data-only process and HTTP host bindings for Node.js, Bun, and embedded
JavaScript runtimes.

The package keeps host execution separate from capability policy. Consumers
pass plain records and receive plain records, so another runtime can implement
the same boundary without exposing callbacks or Node objects.

## Run A Process

```ts
import { nodeBindings } from "@dbx-tools/bindings";

const result = await nodeBindings.runProcess({
  command: "databricks",
  args: ["auth", "token", "--profile", "DEFAULT", "--output", "json"],
});
```

`runProcess()` uses `@dbx-tools/core` execution and returns the exit code plus
normalized optional stdout and stderr strings.

## Execute HTTP

```ts
import { nodeBindings } from "@dbx-tools/bindings";

const response = await nodeBindings.executeHttp({
  url: "https://example.com/api",
  headers: { accept: "application/json" },
});
```

The HTTP binding uses the runtime `fetch` implementation and returns status,
headers, and the complete response body without interpreting its format.
