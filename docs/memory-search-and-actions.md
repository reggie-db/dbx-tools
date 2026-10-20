# Add memory, search, and approved actions

Combine AppKit tool-provider plugins when an agent needs durable user facts,
governed search, web access, or communication actions.

## Add durable memory

Register the memory plugin:

```ts
import { server } from "@databricks/appkit";
import { appkit } from "@dbx-tools/appkit";
import { memory } from "@dbx-tools/appkit-memory";

await appkit.createApp({
  plugins: [
    server(),
    memory({
      databricks: "auto",
      graphiti: true,
    }),
  ],
});
```

The plugin publishes `remember` and `recall_memory`. In `auto` mode, it uses
Databricks Agent Memory when the actor can access the store. A 403 or 404
selects the lazy Graphiti fallback. Other Databricks errors remain errors so a
temporary outage does not split one actor's memory across backends.

Mastra thread storage and PgVector recall remain separate from these tools.

## Choose a search provider

Use native AppKit AI Search for standard Databricks Vector Search queries. Add
[@dbx-tools/search](../packages/js/node/search/README.md) when the application
needs agent tools, federated search, index lifecycle operations, seeding, or a
Lakebase full-text provider.

Choose one AppKit-compatible read provider:

- Native `aiSearch` for Databricks Vector Search.
- `lakebaseAiSearch` for PostgreSQL full-text search with the same aliases,
  routes, and response contract.

Register `search()` beside that provider when agents need `search`,
`universal_search`, or lifecycle tools.

## Add web search

Register
[@dbx-tools/appkit-web-search](../packages/js/node/appkit-web-search/README.md)
when an agent must search or fetch public web content.

`web_search` uses a web-capable Databricks model and returns an answer with
citations. `web_fetch` reads a page. Configure an allowlist and approval policy
when unrestricted URLs are not appropriate.

## Add approved email

Register [@dbx-tools/email](../packages/js/node/email/README.md) and add
`emailTool()` to the agent. Set Mastra's `requireApproval` when sending must
pause for review.

Lakebase-backed Mastra storage persists the suspended run. The Mastra UI
renders the draft, lets the user approve or deny it, and resumes the same run.

## Add the tools to Mastra

Request each sibling toolkit asynchronously:

```ts
import { agents } from "@dbx-tools/appkit-mastra";

const support = agents.createAgent({
  instructions: "Use memory and search when they help answer the request.",
  async tools(plugins) {
    const [memoryTools, searchTools] = await Promise.all([
      plugins.memory?.toolkit(),
      plugins.search?.toolkit(),
    ]);
    return {
      ...memoryTools,
      ...searchTools,
    };
  },
});
```

Tool execution returns to the owning AppKit plugin, which preserves
on-behalf-of-user identity, cancellation, telemetry, and trusted resource
scope.

## Review boundaries

- An Agent Memory `actor_id` partitions storage. It is not an authorization
  boundary.
- Native AI Search uses the app service principal by default. Set an index's
  `auth` to `on-behalf-of-user` when queries must use the signed-in user's
  permissions.
- Lakebase full-text search can use service-principal or on-behalf-of-user
  routing.
- Destructive tools require approval through the Mastra adapter. Routine writes
  require explicit Mastra approval policy when human review is required.
- Browser clients receive plugin routes from client configuration. They do not
  receive Databricks credentials.

## <a id="additional-resources"></a> Additional resources

- [@dbx-tools/appkit-memory](../packages/js/node/appkit-memory/README.md)
- [@dbx-tools/search](../packages/js/node/search/README.md)
- [@dbx-tools/appkit-web-search](../packages/js/node/appkit-web-search/README.md)
- [@dbx-tools/email](../packages/js/node/email/README.md)
- [@dbx-tools/ui-mastra](../packages/js/ui/mastra/README.md)
