# dbx-tools

Companion packages for Databricks developers building Databricks Apps, AppKit
backends, Mastra agents, Genie workflows, and Model Serving integrations.

`dbx-tools` fills the gaps around Databricks-provided packages that are powerful
but often low-level: missing sensible defaults, requiring repeated setup code, or
making common app patterns more cumbersome than they need to be. The packages in
this repo add opinionated defaults, shared schemas, AppKit plugins, UI helpers,
and local developer tools while staying close to Databricks' own APIs.

## Relationship To Native AppKit

Use native AppKit first when it already gives you the exact surface you need.
AppKit has strong built-in plugins for Analytics, Genie, Files, Lakebase, Model
Serving, Jobs, Vector Search, and beta Agents, plus React UI primitives and
hooks. `dbx-tools` is not a fork of that platform and should not replace AppKit
for straightforward cases.

Use these packages when the native surface gets repetitive or narrow for a real
app:

- you need Databricks defaults before AppKit plugins initialize, such as
  Lakebase env discovery or layered config resolution;
- you want Mastra's agent runtime, storage, tools, MCP, and broader ecosystem
  while still running inside AppKit with OBO auth and Databricks plugin tools;
- you want Genie output as typed async events that an agent or custom UI can
  consume, enrich, and turn into chart/data embeds;
- you want model selection by intent (`"sonnet"`, `"chat-fast"`) rather than
  wiring every app to one serving endpoint alias;
- you need local OpenAI-compatible development tooling on top of Databricks
  Model Serving;
- you need reusable UI surfaces for Mastra chat or human-approved email rather
  than a one-off component in each app.

## What This Adds

- **AppKit app defaults** — auto-configure Lakebase/Postgres env, resolve config
  from local files and bundles, access AppKit execution context safely, and look
  up sibling plugins with typed helpers.
- **Mastra inside AppKit** — register one or more Mastra agents as an AppKit
  plugin with OBO auth, Lakebase-backed storage/memory, workspace skills, model
  selection, history, threads, feedback, and scoped route exposure.
- **Genie as agent tools** — stream Genie thinking, SQL, rows, and final results
  as typed events; expose Genie space metadata and starter questions; let agents
  answer with delayed chart and data embeds.
- **Model Serving ergonomics** — turn loose model names such as `"sonnet"` or
  `"chat-fast"` into concrete Databricks serving endpoints using workspace
  catalogues, fuzzy matching, class ceilings, cache, and fallbacks.
- **OpenAI-compatible local proxy** — point OpenAI-shaped clients at Databricks
  Model Serving without hand-managing Databricks auth or endpoint ids.
- **Approval-gated email workflows** — give agents a `send_email` tool that
  suspends for human approval, supports SMTP or local outbox mode, derives safe
  senders, and renders Markdown email.
- **Web search and fetch tools** — give agents `web_search` (the Databricks
  native web-search tool, on its own Gemini/GPT web-capable model, returning an
  answer plus citations) and `web_fetch` (page contents) with an optional URL
  allow-list and per-tool approval gating.
- **Reusable React surfaces** — provide AppKit/Tailwind/Vite foundations, a
  Mastra chat UI, email approval, preview, compose, and Markdown body components.
- **Shared browser-safe contracts** — keep UI, server, tests, and tools aligned
  with zod schemas for Mastra routes, Genie events, model lookup, email payloads,
  and selected Databricks SDK shapes.
- **Reusable brand context** — validate one YAML or JSON source for product
  names, assets, colors, typography, and LLM writing voice, then consume it from
  Node, React, browser helpers, or generated JSON Schema.
- **Databricks infrastructure helpers** — resolve workspace identity, cloud
  region, public IPs, Zerobus endpoints, and Databricks SDK cancellation without
  binding every package to AppKit.

## Quick Start

Install dependencies and type-check the workspace:

```sh
pnpm install
pnpm -r compile
```

For AppKit apps, the most common entrypoint is the Mastra plugin:

```ts
import { analytics, createApp, lakebase, server } from "@databricks/appkit";
import { agents, genie, plugin } from "@dbx-tools/appkit-mastra";

const analyst = agents.createAgent({
  name: "analyst",
  instructions: `Answer with Databricks context.\n\n${genie.GENIE_INSTRUCTIONS}`,
  tools(plugins) {
    return {
      ...plugins.analytics.toolkit(),
      ...plugins.genie?.toolkit(),
    };
  },
});

await createApp({
  plugins: [
    server(),
    analytics(),
    lakebase(),
    plugin.mastra({
      agents: { analyst },
      defaultAgent: "analyst",
      genie: { spaces: { sales: "01ef..." } },
    }),
  ],
});
```

That single plugin registration can provide agent streaming routes, model
resolution, Genie-backed data tools, durable Lakebase storage, chat history,
thread management, feedback, and MCP exposure.

Use `@dbx-tools/ui-mastra` on the client side for the matching chat UI:

```tsx
import { MastraChat } from "@dbx-tools/ui-mastra/react";

export function App() {
  return <MastraChat agentId="analyst" enableThreads showModelPicker />;
}
```

## Feature Packages

| Use case                    | Packages                                                                                                                                             |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| AppKit defaults             | [`@dbx-tools/appkit`](workspaces/node/appkit), [`@dbx-tools/appkit-env`](workspaces/cli/appkit-env)                                             |
| AppKit-hosted agents        | [`@dbx-tools/appkit-mastra`](workspaces/node/appkit-mastra), [`@dbx-tools/shared-mastra`](workspaces/shared/mastra)                             |
| Genie streaming and schemas | [`@dbx-tools/genie`](workspaces/node/genie), [`@dbx-tools/shared-genie`](workspaces/shared/genie)                                               |
| Model Serving selection     | [`@dbx-tools/model`](workspaces/node/model), [`@dbx-tools/shared-model`](workspaces/shared/model)                                               |
| Local model proxy           | [`@dbx-tools/model-proxy`](workspaces/cli/model-proxy)                                                                                               |
| Email workflows             | [`@dbx-tools/email`](workspaces/node/email), [`@dbx-tools/shared-email`](workspaces/shared/email), [`@dbx-tools/ui-email`](workspaces/ui/email) |
| Web search and fetch        | [`@dbx-tools/appkit-web-search`](workspaces/node/appkit-web-search)                                                                                 |
| React/AppKit UI             | [`@dbx-tools/ui-appkit`](workspaces/ui/appkit), [`@dbx-tools/ui-mastra`](workspaces/ui/mastra), [`@dbx-tools/ui-email`](workspaces/ui/email)         |
| Brand context and assets    | [`@dbx-tools/shared-core`](workspaces/shared/core), [`@dbx-tools/core`](workspaces/node/core), [`@dbx-tools/ui-branding`](workspaces/ui/branding) |
| Databricks infrastructure   | [`@dbx-tools/databricks`](workspaces/node/databricks), [`@dbx-tools/databricks-zerobus`](workspaces/node/databricks-zerobus)               |
| Shared utilities            | [`@dbx-tools/shared-core`](workspaces/shared/core), [`@dbx-tools/core`](workspaces/node/core), [`@dbx-tools/path`](workspaces/node/path)   |
| SDK-derived schemas         | [`@dbx-tools/shared-sdk-model`](workspaces/shared/sdk-model)                                                                                         |

Read the package README for each feature area. They are written as the
package-level source of truth: key features, import examples, configuration or
runtime behavior, module maps, and links to adjacent packages.

### Load One Brand File

The root [`branding/brand.yaml`](branding/brand.yaml) is the canonical dbx tools
context and points at the reusable SVG assets beside it. The same schema accepts
JSON.

```ts
import { brand } from "@dbx-tools/core";

const brandContext = await brand.loadBrandContext();
```

Use `brand.BrandContextSchema` from `@dbx-tools/shared-core` in browser-safe
code or structured LLM tools. Use `@dbx-tools/ui-branding/react` and
`@dbx-tools/ui-branding/browser` to render or apply the resulting context.

## Common Workflows

### Add AppKit Defaults

Use [`@dbx-tools/appkit`](workspaces/node/appkit) when an AppKit backend
needs the setup code you would otherwise repeat in every app: Lakebase env
resolution, config lookup, Databricks SDK cancellation bridging, execution
context fallback, and typed sibling plugin access.

```ts
import { lakebase, server } from "@databricks/appkit";
import { createApp } from "@dbx-tools/appkit";

await createApp.createApp({
  plugins: [server(), lakebase()],
});
```

### Resolve Models By Intent

Use [`@dbx-tools/model`](workspaces/node/model) when a UI, agent, or CLI
should ask for a model by capability or loose name instead of hard-coding a
serving endpoint id.

```ts
import { resolve } from "@dbx-tools/model";

const selected = await resolve.selectModel(client, host, {
  explicit: "claude sonnet",
  modelClass: "chat-balanced",
});
```

### Run OpenAI-Shaped Tools Against Databricks

Use [`@dbx-tools/model-proxy`](workspaces/cli/model-proxy) when a local tool
expects OpenAI-compatible endpoints but you want Databricks auth and Model
Serving resolution.

```sh
model-proxy serve --profile my-workspace --port 4000
```

Then point the client at `http://127.0.0.1:4000/v1`.

### Require Human Approval For Email

Use [`@dbx-tools/email`](workspaces/node/email) with
[`@dbx-tools/ui-email`](workspaces/ui/email) when an agent should draft email but
not send it until a user approves the suspended tool call.

```ts
import { plugin as emailPlugin, tool as emailTool } from "@dbx-tools/email";

const agent = agents.createAgent({
  instructions: "Draft emails, then wait for approval before sending.",
  tools: () => ({ send_email: emailTool.emailTool() }),
});

await createApp({
  plugins: [server(), lakebase(), emailPlugin.email(), mastraPlugin.mastra({ agents: agent })],
});
```

## Development

This repository uses a small internal workspace generator so package metadata,
barrels, generated schemas, and examples stay consistent. That tooling is not
the main product surface of the repo, but it is documented for contributors:

- [`@dbx-tools/projen`](projen) documents the projen engine,
  workspace discovery, generated files, mixins, OpenAPI generation, and codegen.
- [`dbx-tools`](workspaces/cli/dbx-tools) documents the contributor CLI.

Useful contributor commands:

```sh
pnpm install
pnpm exec projen
pnpm -r compile
pnpm test
pnpm format
```

## Documentation

The READMEs are the current package-level source of truth. The GitHub Pages site
is generated from those README files, so package docs are not maintained twice.
See [`docs/README.md`](docs/README.md) for the local build command and Pages
workflow.

The continuation plan in
[`plans/appkit-companion-continuation.md`](plans/appkit-companion-continuation.md)
tracks remaining package-follow-up work.
