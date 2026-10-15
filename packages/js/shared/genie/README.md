# @dbx-tools/shared-genie

Validate AI/BI Genie wire payloads and derive UI events from raw message
snapshots without importing the Databricks SDK. Use the browser-safe schemas,
event vocabulary, and snapshot diff helpers in clients, routes, and tests. The
Node driver that calls Genie is [@dbx-tools/genie](../../node/genie).

## Quick start

```ts
import { genieModel } from "@dbx-tools/shared-genie";

const response = genieModel.GenieResponseSchema.parse(await request.json());
```

Use the contracts for:

- Runtime schemas for Genie messages, responses, spaces, attachments, and
  statuses, including fields observed on the live wire.
- Forward-compatible Agent Mode SSE schemas plus a pure reducer that projects
  reasoning, SQL, Markdown output, statement IDs, visualization metadata, and
  terminal status into `GenieMessage`.
- A flat `GenieChatEvent` vocabulary for thinking, SQL, rows, result, status,
  and error rendering.
- Snapshot diff helpers that emit only newly observed semantic events.
- Attachment and status helpers for UI display logic.
- Browser-safe types that allow clients to validate Genie payloads without
  bundling Databricks SDK runtime code.
- Generated Zod schemas for the upstream SDK Dashboard/Genie shapes, so
  validating an unwidened SDK payload needs no SDK import either.

## Choose between AppKit and shared Genie types

Use AppKit's Genie plugin and UI types when you build directly against
the native AppKit Genie routes. Use this package when you need a browser-safe
event vocabulary independent of AppKit transport:

- Validate raw Genie messages captured from the Databricks SDK.
- Replay persisted snapshots as semantic events.
- Share a flat event union between
  [@dbx-tools/genie](../../node/genie),
  [@dbx-tools/appkit-mastra](../../node/appkit-mastra), and custom clients.
- Detect attachment and status shapes that are present on the wire but aren't
  convenient in generated SDK types.

## Validate message snapshots

```ts
import { genieModel } from "@dbx-tools/shared-genie";

const message = genieModel.GenieMessageSchema.parse(rawMessage);
const attachments = genieModel.GenieResponseSchema.parse(rawMessage);
```

The schemas extend generated Databricks SDK Genie types with fields observed on
the wire, including query thoughts, visualization attachments, attachment
discriminators, and serialized space data.

## Handle typed chat events

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

## Derive events from snapshots

```ts
import { event } from "@dbx-tools/shared-genie";

for (const evt of event.eventsFromMessage(current, previous, spaceId)) {
  render(evt);
}
```

Use `eventsFromMessage()` when replaying persisted Genie messages, testing UI
event handling, diffing Agent Mode or polling `GenieMessage` snapshots into the
shared vocabulary, or building a custom polling loop. Individual detectors are
also exported for targeted checks: `detectStatus`, `detectThinking`,
`detectQuery`, `detectRows`, and the other event-specific helpers.

## Work with status and attachments

```ts
import { genieModel } from "@dbx-tools/shared-genie";

export function describeMessage(input: unknown) {
  const message = genieModel.GenieMessageSchema.parse(input);
  const statusLabel = genieModel.isTerminalStatus(message.status)
    ? genieModel.humanizeStatus(message.status)
    : undefined;
  const attachmentType = genieModel.detectAttachmentType(message.attachments?.[0]);
  return { statusLabel, attachmentType };
}
```

`humanizeStatus()` is the shared display-label function. `detectAttachmentType()`
lets consumers switch on `query`, `text`, `suggested_questions`, or `viz`
instead of probing optional fields.

## Event model

The event detector compares the current Genie message with the previous snapshot
from the same turn. This keeps streaming UIs from re-rendering duplicate thought
or query fragments while still allowing full history replay from persisted raw
messages. Consumers can use the full `eventsFromMessage()` helper or individual
detectors when a test needs to assert one specific behavior.

## Validate generated SDK shapes

`dashboards` holds Zod schemas generated from the upstream
`@databricks/sdk-experimental` dashboards declarations. Import it when code needs
to validate a raw Databricks Genie/Dashboard payload against the SDK's own shape:

```ts
import { dashboards } from "@dbx-tools/shared-genie";

const space = dashboards.genieSpaceSchema.parse(rawSpace);
```

Use `genieModel` for schemas that include fields observed on the Genie wire. Use
`dashboards` only when the unwidened Databricks SDK shape is the required
contract. The SDK is a development dependency, so browser bundles include Zod
but not the Databricks SDK runtime.

## Package exports

- `agentMode`: forward-compatible Zod schemas plus the pure Agent Mode event
  reducer and live/history `GenieMessage` projectors.
- `genieModel`: Genie schemas, status helpers, attachment helpers, and event
  union schemas/types.
- `event`: event detector factory, individual detectors, and
  `eventsFromMessage()`.
- `dashboards`: generated, read-only Zod schemas and inferred types for the
  upstream SDK Dashboard/Genie shapes that `genieModel` extends.

This package doesn't call Genie, manage credentials, or own conversation
lifecycle. Server-side streaming is in
[@dbx-tools/genie](../../node/genie).
