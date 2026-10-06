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

`runtime.result` resolves when the supervised runtime exits. Calling `stop()`
terminates Graphiti and shuts down FalkorDB through its durability policy.

## Run Until Exit

Use the foreground helper when another Node entry point owns signal handling:

```ts
import { runGraphiti } from "@dbx-tools/graphiti/runtime";

await runGraphiti({ profile: "MY-PROFILE" });
```

Model selection, route resolution, authentication refresh, process supervision,
and durable FalkorDB lifecycle remain internal to the runtime.

## Embed The Runtime

Use this package from Node applications that need Graphiti lifecycle control.
Use `@dbx-tools/cli-graphiti` for Commander and desktop-service commands, or
`@dbx-tools/appkit-graphiti` for AppKit MCP publication and user scoping.
