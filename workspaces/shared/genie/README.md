# @dbx-tools/shared-genie

Pure types and sync helpers for the Genie chat driver. Wire-format zod schemas
(extending the generated [`@dbx-tools/shared-sdk-model`](../sdk-model) Genie
shapes), the high-level `GenieChatEvent` discriminated union the event driver
emits, and the per-event detectors that derive those events from a
`GenieMessage` snapshot diff.

No `node:*`, no `WorkspaceClient`, no I/O - safe to import from any runtime,
including browser bundles.

```ts
import { genieModel, event, type GenieChatEvent } from "@dbx-tools/shared-genie";

const message = genieModel.GenieMessageSchema.parse(raw);
for (const evt of event.eventsFromMessage(current, previous, spaceId)) {
  // evt: GenieChatEvent
}
```

## Modules

- `genieModel` - widened wire schemas (`GenieMessageSchema`,
  `GenieAttachmentSchema`, …) + the `GenieChatEvent` event vocabulary +
  status helpers (`isTerminalStatus`, `humanizeStatus`).
- `event` - pure detectors + `eventsFromMessage` orchestrator (snapshot diff ->
  typed events).

Unique types are hoisted flat (`import { type GenieMessage } from
"@dbx-tools/shared-genie"`). Server-side chat driving lives in
[`@dbx-tools/node-genie`](../../node/genie).
