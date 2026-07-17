# @dbx-tools/node-genie

Server-side Genie chat drivers. Two async generators that take a `space_id` + a
single `content` string for one turn against a Genie space and yield either the
raw `GenieMessage` snapshots (`chat.genieChat`) or a typed `GenieChatEvent`
stream of flat `{ type, ...fields }` records (`chat.genieEventChat`), plus space
metadata helpers (`space.getGenieSpace`, `space.genieSampleQuestions`).

```ts
import { chat } from "@dbx-tools/node-genie";

for await (const event of chat.genieEventChat(spaceId, "Top 5 stores?")) {
  switch (event.type) {
    case "thinking": console.log("[think]", event.thought_type, event.text); break;
    case "query":    console.log("[sql]", event.title, "\n", event.sql); break;
    case "result":   console.log("[done]", event.status); break;
  }
}
```

Multi-turn conversations are caller-driven: read `conversation_id` off the prior
turn's terminal `GenieMessage` (or the `result` event) and thread it into the
next call's `options.conversationId`. Auth resolves from AppKit's per-request
client when available, else a default-auth `WorkspaceClient` (env / profile).

## Modules

- `chat` - `genieChat` (raw snapshot stream) + `genieEventChat` (event stream).
- `space` - `getGenieSpace` (incl. serialized definition) + `genieSampleQuestions`.

Pure wire contracts + event detectors live in
[`@dbx-tools/shared-genie`](../../shared/genie). `@databricks/appkit` is an
optional peer (lazy-imported; env-var auth fallback).
