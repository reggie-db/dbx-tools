<!-- docs-site:ignore:start -->

**[Documentation](https://docs.dbx.tools/)** - full package
reference, guides, and API docs.

<!-- docs-site:ignore:end -->

# dbx-tools

Companion packages for Databricks developers building Databricks Apps, AppKit
backends, Mastra agents, Genie workflows, and Model Serving integrations.

`dbx-tools` fills gaps around Databricks-provided packages that are often
low-level: missing sensible defaults, requiring repeated setup code, or
making common app patterns more cumbersome than they need to be. The packages in
this repo add opinionated defaults, shared schemas, AppKit plugins, UI helpers,
and local developer tools while staying close to Databricks' own APIs.

## Relationship To Native AppKit

Use native AppKit first when it already gives you the exact surface you need.
AppKit has strong built-in plugins for Analytics, Genie, Files, Lakebase, Model
Serving, Jobs, beta AI Search, and beta Agents, plus React UI primitives and
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
- you need a managed Graphiti memory sidecar with Lakebase recovery, per-user
  graph groups, and a constrained AppKit MCP endpoint;
- you need local OpenAI-compatible development tooling on top of Databricks
  Model Serving;
- you want agent tools, federated search, index lifecycle helpers, reusable
  search components, or a Lakebase full-text provider around native AppKit AI
  Search;
- you need reusable UI surfaces for Mastra chat or human-approved email rather
  than a one-off component in each app.

## What This Adds

- **AppKit app defaults** — auto-configure Lakebase/Postgres env through core
  config sources, access AppKit execution context safely, and look up sibling
  plugins with typed helpers.
- **Core configuration and locking** — resolve scoped settings lazily from
  constant data, the environment, project `.env` files, validated bundles, or
  App YAML with explicit runtime and source overrides; install binaries atomically; and serialize critical
  sections across threads, local processes, or replicas with process, file, and
  Postgres advisory locks.
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
- **Managed Graphiti memory** - provision Graphiti, Neo4j, and LiteLLM; journal
  graph mutations to Lakebase; enforce per-user graph groups; and republish a
  constrained MCP surface through AppKit.
- **Approval-gated email workflows** — give agents a `send_email` tool that
  suspends for human approval, supports SMTP or local outbox mode, derives safe
  senders, and renders Markdown email.
- **Web search and fetch tools** — give agents `web_search` (the Databricks
  native web-search tool, on its own Gemini/GPT web-capable model, returning an
  answer plus citations) and `web_fetch` (page contents) with an optional URL
  allow-list and per-tool approval gating.
- **AI Search extensions and Lakebase full text** - native AppKit `aiSearch`
  owns Vector Search queries, OBO, caching, reranking, pagination, and the React
  query hook. The dbx-tools search packages add agent tools, universal search,
  index creation/sync/seed helpers, `SearchBox` / `SearchResults`, and
  `lakebaseAiSearch`, a PostgreSQL full-text provider with the same AppKit query
  contract.
- **Teams bot endpoint and Adaptive Cards** — give an app a real Bot Framework
  messaging endpoint (inbound JWT validated, replies delivered over the Connector
  API), compile an agent's small card spec into a schema-valid Adaptive Card, and
  render a whole Teams conversation in React.
- **A Postgres message bus** — broadcast a typed envelope to every app instance
  over `LISTEN`/`NOTIFY` with automatic sender context, plus optional persistence
  so a subscriber that missed a message can replay history by cursor.
- **A gated public URL for any command** — `dbx tunnel -- <command>` fronts a
  process with a portr tunnel and an email one-time-code gate, for the case that
  is not an AppKit app at all.
- **Reusable React surfaces** — provide AppKit/Tailwind/Bun foundations, a
  Mastra chat UI plus React Email approval, preview, compose, and delivery components.
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
bun install
bun run --filter '*' compile
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
  return <MastraChat agentId="analyst" threadPlacement="auto" showModelPicker />;
}
```

## Feature Packages

| Use case                       | Packages                                                                                                                                                                                                                    |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AppKit defaults                | [`@dbx-tools/appkit`](packages/js/node/appkit), [`@dbx-tools/cli-appkit-env`](packages/js/cli/appkit-env)                                                                                                                   |
| AppKit-hosted agents           | [`@dbx-tools/appkit-mastra`](packages/js/node/appkit-mastra), [`@dbx-tools/shared-mastra`](packages/js/shared/mastra)                                                                                                       |
| Genie streaming and schemas    | [`@dbx-tools/genie`](packages/js/node/genie), [`@dbx-tools/shared-genie`](packages/js/shared/genie)                                                                                                                         |
| Model Serving selection        | [`@dbx-tools/model`](packages/js/node/model), [`@dbx-tools/shared-model`](packages/js/shared/model)                                                                                                                         |
| Local model proxy              | [`dbx-tools-litellm`](packages/py/litellm)                                                                                                                                                                                  |
| Databricks OAuth tokens        | [`@dbx-tools/cli-auth`](packages/js/cli/auth)                                                                                                                                                                               |
| Public tunnel + access gate    | [`@dbx-tools/tunnel`](packages/js/node/tunnel), [`@dbx-tools/cli-tunnel`](packages/js/cli/tunnel)                                                                                                                           |
| Passwordless authentication    | [`@dbx-tools/auth`](packages/js/node/auth), [`@dbx-tools/shared-auth`](packages/js/shared/auth), [`@dbx-tools/ui-auth`](packages/js/ui/auth)                                                                                |
| Configuration and local locks  | [`@dbx-tools/core`](packages/js/node/core), [`dbx-tools-core`](packages/py/core)                                                                                                                                            |
| Email workflows                | [`@dbx-tools/email`](packages/js/node/email), [`@dbx-tools/shared-email-template`](packages/js/shared/email-template), [`@dbx-tools/shared-email`](packages/js/shared/email), [`@dbx-tools/ui-email`](packages/js/ui/email) |
| Web search and fetch           | [`@dbx-tools/appkit-web-search`](packages/js/node/appkit-web-search)                                                                                                                                                        |
| Graphiti AppKit sidecar        | [`@dbx-tools/appkit-graphiti`](packages/js/node/appkit-graphiti), [`dbx-tools-graphiti`](packages/py/graphiti)                                                                                                              |
| Postgres locks and message bus | [`@dbx-tools/postgres`](packages/js/node/postgres), [`dbx-tools-postgres`](packages/py/postgres)                                                                                                                            |
| AI Search extensions           | [`@dbx-tools/search`](packages/js/node/search), [`@dbx-tools/shared-search`](packages/js/shared/search), [`@dbx-tools/ui-search`](packages/js/ui/search)                                                                    |
| Teams chat and cards           | [`@dbx-tools/teams`](packages/js/node/teams), [`@dbx-tools/shared-teams`](packages/js/shared/teams), [`@dbx-tools/ui-teams`](packages/js/ui/teams)                                                                          |
| React/AppKit UI                | [`@dbx-tools/ui-appkit`](packages/js/ui/appkit), [`@dbx-tools/ui-mastra`](packages/js/ui/mastra), [`@dbx-tools/ui-auth`](packages/js/ui/auth), [`@dbx-tools/ui-email`](packages/js/ui/email)                                |
| Brand context and assets       | [`@dbx-tools/shared-core`](packages/js/shared/core), [`@dbx-tools/core`](packages/js/node/core), [`@dbx-tools/ui-branding`](packages/js/ui/branding)                                                                        |
| Databricks infrastructure      | [`@dbx-tools/databricks`](packages/js/node/databricks), [`@dbx-tools/databricks-zerobus`](packages/js/node/databricks-zerobus)                                                                                              |
| Portable filesystems           | [`@dbx-tools/shared-fs`](packages/js/shared/fs), [`@dbx-tools/fs`](packages/js/node/fs)                                                                                                                                     |
| Shared utilities               | [`@dbx-tools/shared-core`](packages/js/shared/core), [`@dbx-tools/core`](packages/js/node/core), [`@dbx-tools/path`](packages/js/node/path)                                                                                 |
| The `dbx` CLI                  | [`@dbx-tools/cli`](packages/js/cli/dbx-tools), [`@dbx-tools/cli-appkit-env`](packages/js/cli/appkit-env), [`@dbx-tools/cli-auth`](packages/js/cli/auth), [`@dbx-tools/cli-tunnel`](packages/js/cli/tunnel)                  |

Read the package README for each feature area. They are written as the
package-level source of truth: key features, import examples, configuration or
runtime behavior, module maps, and links to adjacent packages.

### Python Packages

Install the published Python packages by distribution name:

```bash
uv add dbx-tools-core dbx-tools-postgres dbx-tools-model dbx-tools-litellm dbx-tools-graphiti
```

The Python packages support Python 3.10 through 3.13.

The root uv workspace contains these Python counterparts:

| Package                                      | Purpose                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`dbx-tools-core`](packages/py/core)         | Loads scoped configuration from constant data, the environment, project `.env` files, validated Databricks bundles, and App YAML with the same precedence as Node, plus dependency-free identity helpers and locked mise-backed executable resolution.                                                           |
| [`dbx-tools-postgres`](packages/py/postgres) | Parses the same Lakebase/Postgres address forms as the Node AppKit helper, creates credential-injected SQLAlchemy engines, provides connection-correct sync/async advisory locks with cross-runtime lock ids, and exposes the Node `PostgresTopicBus` lifecycle and wire envelope.                               |
| [`dbx-tools-model`](packages/py/model)       | Lists and classifies Databricks Model Serving endpoints, derives canonical first-party service names, parses model identities, resolves model intent, builds authenticated invocation requests, sanitizes OpenAI chat payloads, and validates embedding responses without AppKit or Mastra runtime dependencies. |
| [`dbx-tools-litellm`](packages/py/litellm)   | Adds explicit-profile Databricks endpoint discovery and fuzzy, tool-aware model routing while leaving request conversion, transport, streaming, retries, embeddings, and Responses bridging to LiteLLM's built-in Databricks provider.                                                                           |
| [`dbx-tools-graphiti`](packages/py/graphiti) | Launches upstream Graphiti's MCP server with native Neo4j 5 and a managed Databricks LiteLLM proxy, using GPT and GTE defaults without requiring a caller-authored Graphiti config file, plus Postgres write journaling that reconstructs ephemeral graph storage after a restart.                               |

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

Use [`@dbx-tools/appkit`](packages/js/node/appkit) when an AppKit backend
needs the setup code you would otherwise repeat in every app: Lakebase env
resolution, config lookup, Databricks SDK cancellation bridging, execution
context fallback, and typed sibling plugin access.

```ts
import { lakebase, server } from "@databricks/appkit";
import { appkit } from "@dbx-tools/appkit";

await appkit.createApp({
  plugins: [server(), lakebase()],
});
```

### Resolve Models By Intent

Use [`@dbx-tools/model`](packages/js/node/model) when a UI, agent, or CLI
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

Use [`dbx-tools-litellm`](packages/py/litellm) when a local tool expects
OpenAI-compatible endpoints with Databricks auth and Model Serving resolution.

```sh
uv run dbx-litellm --profile my-workspace --port 4000
```

Then point the client at `http://127.0.0.1:4000/v1`.

### Authenticate With Databricks OAuth

Use [`@dbx-tools/cli-auth`](packages/js/cli/auth) for preferred U2M browser
OAuth, M2M client credentials, secure token storage, and refresh.

```sh
dbx auth login --profile my-workspace
dbx auth token --profile my-workspace
dbx auth status --profile my-workspace
```

### Require Human Approval For Email

Use [`@dbx-tools/email`](packages/js/node/email) with
[`@dbx-tools/ui-email`](packages/js/ui/email) when an agent should draft email but
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

### Put A Gated Public URL In Front Of A Command

Use [`@dbx-tools/tunnel`](packages/js/node/tunnel) inside an AppKit app, where the
portr tunnel and the [`@dbx-tools/auth`](packages/js/node/auth) passwordless gate
run in-process through `tunnelInterceptor()` and the `authGate` plugin. The gate
supports Better Auth email OTP recovery and passkeys with Lakebase or SQLite
persistence.

Use [`@dbx-tools/cli-tunnel`](packages/js/cli/tunnel) when the process is not an
AppKit app - a Python service, a static server, a third-party binary - and should
still be reachable only by approved email addresses.

```sh
dbx tunnel --allow databricks.com -- bun src/server.ts
dbx tunnel status --allow databricks.com
```

The wrapper claims the public port, moves the wrapped command to a private one,
and gates traffic in between. `status` prints the resolved configuration without
starting anything.

## Development

This repository uses a small internal workspace generator so package metadata,
barrels, generated schemas, and examples stay consistent. That tooling is not
the main product surface of the repo, but it is documented for contributors:

- [`@dbx-tools/projen`](projen) documents the projen engine,
  package discovery, generated files, mixins, OpenAPI generation, and codegen.
- [`dbx-tools`](packages/js/cli/dbx-tools) documents the contributor CLI.

Useful contributor commands:

```sh
bun install
bunx projen
bun run --filter '*' compile
bun run --filter '*' test
bun run format
uv sync --all-packages
uv run pytest
uv run ruff check packages/py
```

## Documentation

The READMEs are the current package-level source of truth. The GitHub Pages site
is generated from those README files, so package docs are not maintained twice.
See [`docs/README.md`](docs/README.md) for the local build command and Pages
workflow.

The continuation plan in
[`plans/appkit-companion-continuation.md`](plans/appkit-companion-continuation.md)
tracks remaining package-follow-up work.
