# @dbx-tools/genie

Server-side Databricks Genie chat drivers.

Import this package when Node or AppKit backend code needs to run one turn
against a Genie space and consume either raw Genie message snapshots or a typed
event stream. It preserves AppKit OBO auth when called inside an AppKit request,
falls back to the Databricks SDK default auth outside AppKit, and supports
caller-provided cancellation.

Pure Genie schemas and event detector helpers live in
[`@dbx-tools/shared-genie`](../../shared/genie).

Key features:

- Streams the Genie Agent Mode API by default, including reasoning, SQL calls,
  query output, and the synthesized answer.
- Starts new Genie conversations or continues an existing `conversationId`.
- Projects Agent Mode response items onto the existing `GenieMessage` snapshot
  and semantic-event contracts.
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

## Why Not Just AppKit Genie?

Native AppKit's Genie plugin is the right choice for a standalone Genie chat
experience: it provides named space aliases, SSE status updates, conversation
history replay, query result fetching, OBO execution, and the AppKit UI
`GenieChat` component.

Use this package when Genie is one capability inside a larger agent or custom
backend:

- You want a low-level async iterator rather than an AppKit HTTP route.
- You want raw message snapshots or a normalized event stream that can be fed
  into Mastra writer events, logs, tests, or custom SSE endpoints.
- You need to diff snapshots and emit only newly observed thinking, SQL, rows,
  result, and error events.
- You want to combine Genie answers with agent-side chart planning, statement
  row fetches, or durable thread storage owned elsewhere.
- You need the same driver to work inside AppKit with OBO auth and outside
  AppKit from scripts using normal Databricks SDK auth.

## Stream Semantic Events

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
events where consumers care about progress and SQL, not just the terminal
message.

## Stream Raw Message Snapshots

```ts
import { chat } from "@dbx-tools/genie";

for await (const message of chat.genieChat(spaceId, "Top stores by revenue?")) {
  renderSnapshot(message);
}
```

`chat.genieChat()` starts an Agent Mode response or continues an existing
conversation, projects SSE output into `GenieMessage` snapshots, filters
identical consecutive payloads, and stops after a terminal response. Set
`agentMode: false` to force the legacy start/create/get-message polling flow.
Use it when you want to run your own diffing or persist the normalized wire
shape. Agent Mode returns query output inline as Markdown; use polling when a
consumer specifically requires the legacy `statement_id`.

## Continue A Conversation

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

The driver does not own multi-turn state. Callers read the conversation id from
a yielded message/event and pass it into the next turn. That makes the package
usable in stateless route handlers, durable thread stores, and one-off scripts.

This split is deliberate: the package is a transport/driver layer, not a thread
store. AppKit-Mastra persists thread state separately and passes the Genie
conversation id back into this driver when a turn continues.

## Resolve A Workspace Client

```ts
import { createWorkspaceClient } from "@databricks/appkit";
import { chat } from "@dbx-tools/genie";

await chat.genieEventChat(spaceId, content, {
  workspaceClient: createWorkspaceClient(),
});
```

Client resolution order:

1. `options.workspaceClient`;
2. AppKit execution-context client, when present;
3. `createWorkspaceClient()` using AppKit's normal Databricks auth chain.

Pass `options.context` as an `AbortSignal` or SDK context to cancel the Agent
Mode stream, SDK calls, and any polling fallback sleep.

## Read Space Metadata And Starter Questions

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
still resolves the space and simply reports no starter questions. Every other
failure - a cancelled request, a missing space, a retry that also fails - is
thrown.

## Options

`chat.GenieChatOptions` is shared by both drivers:

- `conversationId` - append to an existing Genie conversation.
- `agentMode` - use Agent Mode SSE, default `true`; `false` forces polling.
- `enableVisualization` - request Agent Mode visualization generation.
- `workspaceClient` - explicit Databricks SDK client.
- `pollIntervalMs` - legacy fallback polling cadence, default `500`.
- `context` - SDK `Context` or `AbortSignal` for cancellation.

## Modules

- `chat` - `genieChat()` raw snapshot stream and `genieEventChat()` typed event
  stream.
- `agentMode` - `genieAgentModeChat()`, availability classification, and Agent
  Mode transport options.
- `space` - `getGenieSpace()` and `genieSampleQuestions()`.

The AppKit-Mastra package builds its Genie tools on top of this driver; see
[`@dbx-tools/appkit-mastra`](../appkit-mastra) for the agent-level
workflow.
