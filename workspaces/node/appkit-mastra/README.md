# @dbx-tools/node-appkit-mastra

The AppKit Mastra agent layer: a `mastra` AppKit plugin that stands up a Mastra
agent server over Databricks - agents, memory (Lakebase Postgres + fastembed),
MCP, OpenTelemetry observability, and the Genie / model / chart / history /
thread tooling - behind an Express mount.

```ts
import { mastra } from "@dbx-tools/node-appkit-mastra";
import { createApp } from "@dbx-tools/node-appkit";

await createApp({ plugins: [mastra({ genie: { spaces: { sales: "01ef..." } } })] });
```

## Modules (namespaced on the barrel)

- `plugin` - the AppKit `mastra` plugin (server, routes, agent registry).
- `agents` - agent construction + the fallback agent.
- `model` - per-step Model Serving resolver (`buildModel`) over node-model.
- `genie` - Genie tools (`ask_genie`, statement/chart markers) over node-genie.
- `memory` / `storage-schema` - Lakebase-backed Mastra Memory.
- `mcp` - MCP server/tool wiring; `observability` - OTel + MLflow trace ids.
- `chart` / `summarize` / `history` / `threads` - chart planning, summaries,
  and conversation history / thread management routes.
- `server` / `rest` / `pagination` / `processors` / `writer` - the Express
  server, REST helpers, stream processors, and SSE writer.

Consumes the browser-safe [`shared-mastra`](../../shared/mastra) wire contract.
Heavy runtime deps (`@mastra/*`, `pg`, `@opentelemetry/api`) and
`@databricks/appkit` are all required - the plugin composes them together, so
they can't be gated apart. This is the AppKit-specific composition; generic
Mastra-only code would live elsewhere.
