# @dbx-tools/shared-generator

Use browser-safe contracts and streaming clients for
`@dbx-tools/appkit-generator`.

## Stream brand generation

```ts
import {
  GENERATOR_PLUGIN_NAME,
  GeneratorPluginClient,
  type GeneratorClientConfig,
} from "@dbx-tools/shared-generator/brand";

const config: GeneratorClientConfig = { basePath: "/api/generator" };
const client = new GeneratorPluginClient(config);

for await (const event of client.generate({ name: "Databricks" })) {
  if (event.type === "result") applyBrand(event.package.brand);
}
```

## Use workflow contracts

The `brand` module owns standalone brand request and streaming contracts. The
`kpi` module owns cited KPI research. The `workflow` module owns generator
requests, constrained data plans, per-user schema records, and terminal
dashboard-or-Genie results.

This package contains no Node, AppKit, Mastra, or Databricks SDK runtime code.
