# @dbx-tools/shared-genie

Browser-safe Genie schemas, event vocabulary, and snapshot diff helpers.

Import this package when a UI, test, or server component needs to validate Genie
wire payloads or derive high-level events from raw Genie message snapshots
without importing the Databricks SDK. The Node driver that calls Genie is
[`@dbx-tools/node-genie`](../../node/genie).

Key features:

- Runtime schemas for Genie messages, responses, spaces, attachments, and
  statuses, including fields observed on the live wire.
- A flat `GenieChatEvent` vocabulary for thinking, SQL, rows, result, status,
  and error rendering.
- Snapshot diff helpers that emit only newly observed semantic events.
- Attachment and status helpers for UI display logic.
- Browser-safe types that allow clients to validate Genie payloads without
  bundling Databricks SDK runtime code.

## Why Not Just AppKit Genie Types?

Use AppKit's Genie plugin and UI types when you are building directly against
the native AppKit Genie routes. Use this package when you need a browser-safe
event vocabulary independent of AppKit transport:

- validating raw Genie messages captured from the Databricks SDK;
- replaying persisted snapshots into semantic events;
- sharing a flat event union between `@dbx-tools/node-genie`,
  `@dbx-tools/node-appkit-mastra`, and custom UI/tests;
- detecting attachment/status shapes that are present on the live wire but not
  always convenient in generated SDK types.

## Validate Genie Wire Payloads

```ts
import { genieModel } from "@dbx-tools/shared-genie";

const message = genieModel.GenieMessageSchema.parse(rawMessage);
const attachments = genieModel.GenieResponseSchema.parse(rawMessage);
```

The schemas extend generated Databricks SDK Genie types with fields observed on
the wire, including query thoughts, attachment discriminators, and serialized
space data.

## Handle Typed Chat Events

```ts
import { type GenieChatEvent } from "@dbx-tools/shared-genie";

function render(event: GenieChatEvent) {
  switch (event.type) {
    case "thinking":
      return showThought(event.thought_type, event.text);
    case "query":
      return showSql(event.sql);
    case "result":
      return markDone(event.status);
  }
}
```

The event union is flat: every variant has `type` plus its own fields and shared
location fields such as `space_id`, `conversation_id`, and `message_id`.

## Derive Events From Snapshots

```ts
import { event } from "@dbx-tools/shared-genie";

for (const evt of event.eventsFromMessage(current, previous, spaceId)) {
  render(evt);
}
```

Use `eventsFromMessage()` when replaying persisted Genie messages, testing UI
event handling, or building a custom polling loop. Individual detectors are also
exported for targeted checks: `detectStatus`, `detectThinking`, `detectQuery`,
`detectRows`, and the other event-specific helpers.

## Work With Status And Attachments

```ts
import { genieModel } from "@dbx-tools/shared-genie";

if (genieModel.isTerminalStatus(message.status)) {
  console.log(genieModel.humanizeStatus(message.status));
}

const kind = genieModel.detectAttachmentType(message.attachments?.[0]);
```

`humanizeStatus()` is the shared display-label function. `detectAttachmentType()`
lets consumers switch on `query`, `text`, or `suggested_questions` instead of
probing optional fields.

## Event Model

The event detector compares the current Genie message with the previous snapshot
from the same turn. This keeps streaming UIs from re-rendering duplicate thought
or query fragments while still allowing full history replay from persisted raw
messages. Consumers can use the full `eventsFromMessage()` helper or individual
detectors when a test needs to assert one specific behavior.

## Modules

- `genieModel` - Genie schemas, status helpers, attachment helpers, and event
  union schemas/types.
- `event` - event detector factory, individual detectors, and
  `eventsFromMessage()`.

Server-side streaming is in [`@dbx-tools/node-genie`](../../node/genie).
