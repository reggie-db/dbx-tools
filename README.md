<!-- docs-site:ignore:start -->

**[Documentation](https://docs.dbx.tools/)** - guides, package reference, and API reference.

<!-- docs-site:ignore:end -->

# dbx-tools

Build Databricks Apps, agents, and local developer tools without reimplementing
authentication, model routing, durable memory, per-user compute, or production
UI.

`dbx-tools` extends Databricks AppKit with Mastra agents, direct Genie chat,
Lakebox workloads, model gateways, Databricks-first memory, search, approved
actions, local services, and reusable React components.

## Choose what to build

- [Build an AppKit application](docs/get-started-appkit.md) with Databricks
  authentication, server plugins, shared configuration, and React UI.
- [Build an agent or Genie experience](docs/agents-and-genie.md) with native
  AppKit Agents, Mastra, direct Genie chat, durable threads, and data embeds.
- [Give each app user a Lakebox](docs/lakebox.md) with a terminal, desktop,
  persistent home, OCI services, and a Mastra workspace sandbox.
- [Connect model clients to Databricks](docs/model-gateway.md) using OpenAI
  Responses, Chat Completions, Anthropic Messages, embeddings, or Codex.
- [Add memory, search, and approved actions](docs/memory-search-and-actions.md)
  to an AppKit or Mastra application.
- [Work with Databricks files and ingestion](docs/data-and-files.md) using
  AppKit Files, portable filesystems, or Zerobus.
- [Use the dbx CLI and local services](docs/cli-and-local-services.md) for
  authentication, Lakebase proxying, Genie Code, model gateways, and tunnels.

## Capabilities

### Agents and conversational data

Use [@dbx-tools/appkit-mastra](packages/js/node/appkit-mastra) for Mastra
agents with AppKit authentication, Lakebase-backed threads, model selection,
tools, approvals, MCP, and tracing. Use
[@dbx-tools/genie](packages/js/node/genie) for typed Genie Agent Mode events.
Use [@dbx-tools/ui-mastra](packages/js/ui/mastra) for Mastra or direct Genie
chat.

### Per-user Lakebox workloads

Use [@dbx-tools/appkit-lakebox](packages/js/node/appkit-lakebox) to give each
authenticated app user a locked Linux account, persistent home, terminal,
desktop, service routes, and machine metrics in one app-managed Lakebox. Use
[@dbx-tools/ui-lakebox](packages/js/ui/lakebox) for the matching React
controls.

### Model and coding-tool gateways

Use
[@dbx-tools/appkit-model-gateway](packages/js/node/appkit-model-gateway) to
serve OpenAI, Anthropic, embedding, and Codex protocols from AppKit or the
standalone `dbx model-gateway` command. Model discovery includes workspace
serving endpoints and supported `system.ai.*` services.

### Memory, search, and actions

Use [@dbx-tools/appkit-memory](packages/js/node/appkit-memory) for
actor-scoped memory that checks Databricks Agent Memory first and starts
Graphiti only when the managed store is unavailable. Add AI Search, Lakebase
full-text search, web search, or email tools from their owning packages.

### Local Databricks development

Use [@dbx-tools/cli](packages/js/cli/dbx-tools) for Databricks authentication,
Lakebase proxying, managed Genie Code, model gateway services, Graphiti, gated
tunnels, and AppKit environment export. Use
[@dbx-tools/cli-service](packages/js/cli/service) to install supported commands
as current-user background services.

### Data and files

Use native AppKit Files for application routes and UI over Unity Catalog
volumes. Use [@dbx-tools/databricks](packages/js/node/databricks) for portable
Workspace, volume, and DBFS access in backend or agent code. Use
[@dbx-tools/databricks-zerobus](packages/js/node/databricks-zerobus) for
region-aware Zerobus ingest streams.

### UI and browser-safe contracts

Use [@dbx-tools/ui](packages/js/ui/appkit) for AppKit-oriented foundations,
branding, authentication, email, and search. Mastra and Lakebox have separate
UI packages. Shared packages own the Zod contracts that cross the browser and
server boundary.

### Python interoperability

Use [dbx-tools-graphiti](packages/py/graphiti) for the Graphiti REST and MCP
runtime with PostGraph storage. Use
[dbx-tools-node-runtime](packages/py/node-runtime) to run generated
PythonMonkey-backed Node packages in notebooks, Lakeflow Jobs, and other
managed Python environments.

## Use native AppKit first

AppKit provides Analytics, Genie, Files, Lakebase, Model Serving, Jobs, UI
components, testing, and evaluation contracts. It also provides beta AI Search
and beta Agents plugins. Use those surfaces directly when they meet the
application requirement.

Use dbx-tools for integration and policy that remain outside the native owner,
including:

- Mastra hosting and direct Genie chat in one AppKit application.
- Per-user Lakebox accounts, workloads, routes, metrics, and sandbox adapters.
- Databricks-first memory with a lazy Graphiti fallback.
- OpenAI, Anthropic, embedding, and Codex protocol gateways.
- Approval-gated communication, federated search, and local service
  supervision.
- Shared configuration, authentication, and browser-safe contracts used across
  these capabilities.

This repository tests `@databricks/appkit` and `@databricks/appkit-ui` 0.81 as
an exact pair.

## Requirements and boundaries

- Use Bun for JavaScript and TypeScript package management, scripts, and tests.
- The published Python packages require Python 3.10 or later and earlier than
  Python 4.
- Workspace operations require an explicit Databricks profile or AppKit
  execution context.
- AppKit browser clients use each plugin's published client configuration and
  shared route contracts.
- Some Databricks and AppKit integrations are beta or depend on preview APIs.
  Each package guide identifies those limits.

## <a id="additional-resources"></a> Additional resources

- [Start-here guides](docs)
- [Package reference](packages)
- [CLI reference](packages/js/cli/dbx-tools)
- [Generated API reference](https://docs.dbx.tools/api/)
- [Release notes](docs/releases)
- [Contributor and generator guide](projen)

<!-- docs-site:ignore:start -->

## Develop this repository

Install dependencies and synthesize generated files:

```bash
bun install
bunx projen
```

Run focused package checks before broader workspace validation:

```bash
bun run --filter '<package-name>' compile
bun run --filter '<package-name>' test
bun run docs:check-readmes
bun run docs:link-check
```

Use [projen/README.md](projen/README.md) for package generation and workspace
development. Use [docs/README.md](docs/README.md) for the local documentation
build.

<!-- docs-site:ignore:end -->
