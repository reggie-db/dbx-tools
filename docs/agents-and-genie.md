# Build agents and Genie experiences

Choose native AppKit Agents, Mastra, or direct Genie based on who owns the
conversation and which runtime features the application needs.

## Choose the conversation owner

Use the beta native AppKit Agents plugin when the application needs
AppKit-native agent definitions, tools, streaming, threads, cancellation, and
approvals. Follow the
[AppKit Agents documentation](https://developers.databricks.com/docs/appkit/v0)
for that workflow.

Use [@dbx-tools/appkit-mastra](../packages/js/node/appkit-mastra/README.md)
when the application already uses Mastra or needs Mastra memory, workflows,
MCP, processors, workspaces, or its tool ecosystem.

Use direct Genie chat when one Genie space owns the conversation. Direct Genie
keeps messages and threads in Genie. It does not write Mastra memory.

## Register a Mastra agent

Install the agent packages:

```bash
bun add @databricks/appkit @dbx-tools/appkit @dbx-tools/appkit-mastra
```

Register an agent:

```ts
import { genie, lakebase, server } from "@databricks/appkit";
import { appkit } from "@dbx-tools/appkit";
import { agents, mastra } from "@dbx-tools/appkit-mastra";

const analyst = agents.createAgent({
  instructions: "Answer questions about workspace data.",
  async tools(plugins) {
    return {
      ...((await plugins.genie?.toolkit()) ?? {}),
    };
  },
});

await appkit.createApp({
  plugins: [
    server(),
    genie(),
    lakebase(),
    mastra({
      agents: { analyst },
      defaultAgent: "analyst",
      genieSpaces: {
        sales: process.env.DATABRICKS_GENIE_SPACE_ID!,
      },
    }),
  ],
});
```

Registering `lakebase()` enables Mastra thread storage and vector memory unless
you disable them. The default command sandbox is Monty. Use the Lakebox adapter
when commands need a persistent Linux home or long-running services.

## Render Mastra chat

Install the UI package and render the matching agent:

```tsx
import { MastraChat } from "@dbx-tools/ui-mastra/react";

export function ChatPage() {
  return <MastraChat agentId="analyst" threadPlacement="auto" showModelPicker />;
}
```

Import `@dbx-tools/ui-mastra/styles.css` after the AppKit UI theme.

The UI supports streaming, thread management, approvals, feedback, exports,
model selection, chart and data embeds, and application request context.

## Render direct Genie chat

Select a configured Genie alias instead of an agent:

```tsx
import { MastraChat } from "@dbx-tools/ui-mastra/react";

export function GeniePage() {
  return <MastraChat genieSpace="sales" threadPlacement="auto" />;
}
```

The server's direct Genie routes use the signed-in user's on-behalf-of-user
identity. The caller must have access to the configured Genie space.

## Add tools and approvals

AppKit tool-provider plugins flow into Mastra through the
`tools(plugins)` callback. Await each toolkit because providers can perform
asynchronous discovery.

Tools marked as destructive require approval through the adapter. Set Mastra's
`requireApproval` on a tool when a regular write also requires human approval.
Lakebase-backed storage is required to persist and resume a suspended run.

## Add persistent command execution

Use [Run per-user Lakebox workloads](lakebox.md) to share one Lakebox runtime
between the AppKit plugin and Mastra workspace sandbox.

## <a id="additional-resources"></a> Additional resources

- [@dbx-tools/appkit-mastra](../packages/js/node/appkit-mastra/README.md)
- [@dbx-tools/genie](../packages/js/node/genie/README.md)
- [@dbx-tools/ui-mastra](../packages/js/ui/mastra/README.md)
- [@dbx-tools/shared-mastra](../packages/js/shared/mastra/README.md)
- [@dbx-tools/shared-genie](../packages/js/shared/genie/README.md)
