# @dbx-tools/genie

Run Databricks Genie turns from Node or AppKit code as raw message snapshots or
a typed event stream. AppKit requests keep their on-behalf-of-user (OBO)
identity, standalone callers use the Databricks SDK authentication chain, and
both modes support cancellation.

## Quick start

```ts
import { chat } from "@dbx-tools/genie";

const spaceId = process.env.DATABRICKS_GENIE_SPACE_ID!;

for await (const event of chat.genieEventChat(spaceId, "Top stores by revenue?")) {
  console.log(event.type, event);
}
```

Pure Genie schemas and event detector helpers live in
[@dbx-tools/shared-genie](../../shared/genie).

The driver:

- Streams the Genie Agent Mode API by default, including reasoning, SQL calls,
  query output, and the synthesized answer.
- Starts new Genie conversations or continues an existing `conversationId`.
- Projects Agent Mode response items onto the existing `GenieMessage` snapshot
  and semantic-event contracts, including statement ids and visualization
  attachments.
- Loads Agent Mode conversation items and groups them back into one
  `GenieMessage` per turn for history replay.
- Retains the Conversation API polling driver behind `agentMode: false` and as
  an automatic pre-stream fallback for `FEATURE_DISABLED` or preview-toggle
  errors.
- Converts raw Genie messages into semantic events for thinking text, generated
  SQL, row counts, final results, and errors.
- Preserves AppKit OBO auth when called during an AppKit request, but also works
  from standalone scripts with normal Databricks SDK auth.
- Accepts SDK `Context` or web `AbortSignal` cancellation for route handlers and
  CLI tools.
- Fetches Genie space metadata and starter questions for UI suggestions.

## Choose Genie integration

Use native AppKit's Genie plugin for a standalone Genie chat experience. It
provides named space aliases, SSE status updates, conversation
history replay, query result fetching, OBO execution, and the AppKit UI
`GenieChat` component.

Use direct Genie when one Genie space owns the conversation and answer. Use
[@dbx-tools/appkit-mastra](../appkit-mastra) when a supervising agent must
combine Genie with other tools, Mastra memory, approvals, or workflows. Use
this package directly when custom backend code needs the lower-level stream:

- You want a low-level async iterator rather than an AppKit HTTP route.
- You want raw message snapshots or a normalized event stream that can be fed
  into Mastra writer events, logs, tests, or custom SSE endpoints.
- You need to diff snapshots and emit only newly observed thinking, SQL, rows,
  result, and error events.
- You want to combine Genie answers with agent-side chart planning, statement
  row fetches, or durable thread storage owned elsewhere.
- You need the same driver to work inside AppKit with OBO auth and outside
  AppKit from scripts using normal Databricks SDK auth.

## Handle semantic events

```ts
import { chat } from "@dbx-tools/genie";

for await (const event of chat.genieEventChat(spaceId, "Top stores by revenue?")) {
  switch (event.type) {
    case "thinking":
      console.log(event.thought_type, event.text);
      break;
    case "query":
      console.log(event.sql);
      break;
    case "rows":
      console.log(event.row_count);
      break;
    case "result":
      console.log(event.status);
      break;
  }
}
```

`chat.genieEventChat()` wraps the lower-level snapshot stream and yields a
`GenieChatEvent` union. Use it for SSE streams, log pipelines, and tool writer
events where consumers care about progress and SQL rather than only the terminal
message.

## Stream raw message snapshots

```ts
import { chat } from "@dbx-tools/genie";

for await (const message of chat.genieChat(spaceId, "Top stores by revenue?")) {
  renderSnapshot(message);
}
```

`chat.genieChat()` starts an Agent Mode response or continues an existing
conversation, projects SSE output into `GenieMessage` snapshots, filters
identical consecutive payloads, and stops after a terminal response. Set
`agentMode: false` to force the Conversation API start/create/get-message
polling flow. Use it when you want to run your own diffing or persist the
normalized wire shape. Agent Mode returns query output inline as Markdown and
copies a query output's `statement_id` onto the matching query attachment when
Databricks supplies one.

## Continue a conversation

```ts
let conversationId: string | undefined;

for (const prompt of prompts) {
  for await (const event of chat.genieEventChat(spaceId, prompt, { conversationId })) {
    if ("conversation_id" in event && event.conversation_id) {
      conversationId = event.conversation_id;
    }
  }
}
```

Callers keep multi-turn state by reading the conversation id from a yielded
message or event and passing it into the next turn. This works in stateless
route handlers, durable thread stores, and one-off scripts. AppKit-Mastra stores
the id with its thread and passes it back when a conversation continues.

## Resolve a workspace client

```ts
import { createWorkspaceClient } from "@databricks/appkit";
import { chat } from "@dbx-tools/genie";

await chat.genieEventChat(spaceId, content, {
  workspaceClient: createWorkspaceClient(),
});
```

Client resolution order:

1. `options.workspaceClient`.
1. AppKit execution-context client, when present.
1. `createWorkspaceClient()` using AppKit's normal Databricks auth chain.

Pass `options.context` as an `AbortSignal` or SDK context to cancel the Agent
Mode stream, SDK calls, and any polling fallback sleep.

## Read space metadata and starter questions

```ts
import { space } from "@dbx-tools/genie";

const genieSpace = await space.getGenieSpace(spaceId);
const questions = space.genieSampleQuestions(genieSpace);
```

`space.getGenieSpace()` fetches the space definition, including serialized space
metadata by default. `space.genieSampleQuestions()` extracts curated starter
questions and returns `[]` when none are configured.

The serialized blob needs `Can Edit` on the space, while `Can Run` is enough for
title and description. When the workspace rejects the serialized request for
lack of permission, `getGenieSpace()` retries once without it and logs
`serialized-space:forbidden`, so an app service principal holding only `Can Run`
still resolves the space and reports no starter questions. Every other
failure - a cancelled request, a missing space, a retry that also fails - is
thrown.

## Options

`chat.GenieChatOptions` is shared by both drivers:

- `conversationId` - append to an existing Genie conversation.
- `agentMode` - use Agent Mode SSE, default `true`. `false` forces polling.
- `agentModeFallback` - fall back to classic polling when Agent Mode is
  unavailable, default `true`. Direct Agent-only callers set `false`.
- `enableVisualization` - request Agent Mode visualization generation.
- `workspaceClient` - explicit Databricks SDK client.
- `pollIntervalMs` - fallback polling cadence, default `500`.
- `context` - SDK `Context` or `AbortSignal` for cancellation.

## Download an original chart

After requesting visualizations, select the message attachment with a `viz`
field and download its PNG using the same conversation and message IDs:

```ts
import { downloadGenieVisualization } from "@dbx-tools/genie";

const visualization = message.attachments?.find((attachment) => attachment.viz);
if (visualization?.attachment_id) {
  const png = await downloadGenieVisualization(
    {
      space_id: message.space_id,
      conversation_id: message.conversation_id,
      message_id: message.message_id,
      attachment_id: visualization.attachment_id,
    },
    { workspaceClient },
  );
}
```

Use the visualization's attachment ID, not its linked query attachment ID.
The SDK's `raw: true` transport returns the binary body and keeps normal SDK
authentication and cancellation. The helper validates the PNG response and
returns the original bytes; it does not replot data or convert images to SVG.
This endpoint also accepts visualization attachments from Agent Mode
conversations.

## Modules

- `chat` - `genieChat()` raw snapshot stream and `genieEventChat()` typed event
  stream.
- `agentMode` - `genieAgentModeChat()`, availability classification, and Agent
  Mode transport options plus Agent Mode conversation history.
- `space` - `getGenieSpace()` and `genieSampleQuestions()`.
- `visualization` - `downloadGenieVisualization()` for original PNG downloads.

The AppKit-Mastra package builds its Genie tools on top of this driver. See
[@dbx-tools/appkit-mastra](../appkit-mastra) for the agent-level
workflow.
