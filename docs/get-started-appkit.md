# Build an AppKit application with dbx-tools

Use dbx-tools with Databricks AppKit when your application needs shared
configuration, Mastra, Lakebox, model gateways, memory, search, communication
tools, or reusable UI.

## Install the AppKit helpers

Add AppKit and the dbx-tools AppKit package to your application:

```bash
bun add @databricks/appkit @dbx-tools/appkit
```

Create the server:

```ts
import { server } from "@databricks/appkit";
import { appkit } from "@dbx-tools/appkit";

await appkit.createApp({
  plugins: [server()],
});
```

The dbx-tools wrapper resolves supported Databricks and Lakebase configuration
before AppKit initializes plugins. It then delegates application construction
to AppKit.

## Add the owning plugin

Use the native AppKit plugin when it provides the complete capability:

- Analytics for SQL warehouse queries.
- Genie for Genie conversations.
- Files for Unity Catalog volumes.
- Lakebase for PostgreSQL pools.
- Model Serving for endpoint invocation.
- Jobs, AI Search, and Agents for their AppKit-native workflows.

Add a dbx-tools plugin for behavior outside that native surface:

- [@dbx-tools/appkit-mastra](../packages/js/node/appkit-mastra/README.md)
  hosts Mastra agents.
- [@dbx-tools/appkit-lakebox](../packages/js/node/appkit-lakebox/README.md)
  adds per-user Lakebox workloads.
- [@dbx-tools/appkit-model-gateway](../packages/js/node/appkit-model-gateway/README.md)
  exposes OpenAI, Anthropic, embedding, and Codex routes.
- [@dbx-tools/appkit-memory](../packages/js/node/appkit-memory/README.md)
  adds Databricks-first durable memory tools.
- [@dbx-tools/search](../packages/js/node/search/README.md),
  [@dbx-tools/email](../packages/js/node/email/README.md), and
  [@dbx-tools/teams](../packages/js/node/teams/README.md) add search and
  communication tools.

## Add browser UI

Use [@dbx-tools/ui](../packages/js/ui/appkit/README.md) for common AppKit UI,
branding, authentication, email, and search. Use the separate Mastra, Lakebox,
or Teams UI package when the backend registers that capability.

Import the owning package stylesheet after the AppKit UI theme. Browser clients
read plugin routes from published client configuration. Do not copy server route
strings or send Databricks credentials to the browser.

## Configure identity and resources

AppKit supplies the application service principal and on-behalf-of-user
execution contexts. Each plugin guide states which identity it uses.

Bundle-managed Databricks Apps keep the runtime command in `app.yaml`. Define
environment variables and resource bindings under the app resource in
`databricks.yml`.

## <a id="additional-resources"></a> Additional resources

- [Build agents and Genie experiences](agents-and-genie.md)
- [Run per-user Lakebox workloads](lakebox.md)
- [Connect model clients to Databricks](model-gateway.md)
- [Add memory, search, and approved actions](memory-search-and-actions.md)
- [Use the dbx CLI and local services](cli-and-local-services.md)
