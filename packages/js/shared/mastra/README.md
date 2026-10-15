# @dbx-tools/shared-mastra

Validate browser-facing data exchanged with
[@dbx-tools/appkit-mastra](../../node/appkit-mastra). It defines the shared
route constants, headers, embed markers, feedback schemas, thread selection
fields, published client configuration, and response schemas.

## Quick start

```ts
import { wire } from "@dbx-tools/shared-mastra";

const config = wire.MastraClientConfigSchema.parse(await response.json());
```

The shared contract includes:

- Route constants for the official AI SDK chat mount and AppKit-Mastra
  additions, including suggestions, model lists, the per-agent default-model
  lookup, embeds, feedback, and direct Genie chat. Agent history and threads
  use Mastra's native client API. Direct mode maps Genie conversations and
  messages onto the same UI contracts.
- Header/query/body constants for thread selection and model override requests.
- Embed-marker parsing for delayed chart and statement-data payloads in
  streaming assistant text.
- Zod schemas for plugin-published client config and route responses.
- MLflow feedback request/response schemas and trace-header constants.
- Browser-safe types that let UI packages stay aligned with the server without
  importing Node or Mastra runtime code.

## Runtime boundary

This package contains contracts and pure helpers. It doesn't register AppKit
plugins, call Databricks services, run Mastra agents, or persist conversation
state. Use [@dbx-tools/appkit-mastra](../../node/appkit-mastra) for server
workflows and [@dbx-tools/ui-mastra](../../ui/mastra) for React chat.

## Validate published client configuration

```ts
import { wire } from "@dbx-tools/shared-mastra";

const config = wire.MastraClientConfigSchema.parse(await response.json());
```

`wire.MastraClientConfigSchema` validates the plugin-published client
configuration, including the mount path, default agent, agent roster, feedback
availability, background-turn support, and chat identity behavior. Use the
published configuration instead of hard-coding server paths.

## Use route constants

```ts
import { routes } from "@dbx-tools/shared-mastra";

const suggestionsUrl = `${basePath}${routes.MASTRA_ROUTES.suggestions}`;
const chatUrl = `${basePath}${routes.MASTRA_ROUTES.chat}/${agentId}`;
```

`routes.MASTRA_ROUTES` keeps client fetch calls aligned with plugin route names
for chat, models, the default-model lookup, suggestions, feedback, and embeds.

## Select threads and models

```ts
import { override, thread } from "@dbx-tools/shared-mastra";

await fetch(chatUrl, {
  method: "POST",
  headers: {
    [thread.THREAD_ID_HEADER]: activeThreadId,
    [override.MODEL_OVERRIDE_HEADER]: "claude sonnet",
  },
  body: JSON.stringify({ messages }),
});
```

Use the header/query constants instead of string literals so browser code,
server middleware, and tests agree on how a request selects the active
conversation and model.

## Parse embed markers

```ts
import { markers } from "@dbx-tools/shared-mastra";

const parts = markers.parseMarkers("Here is the chart:\n[chart:abc123]");
const safeText = markers.stripIncompleteMarkerTail(streamingText);
```

Markers let an agent mention large or delayed artifacts by id, such as
`[chart:<id>]`, `[data:<statement_id>]`, and
`[visualization:<statement_id>]`. The visualization marker selects AppKit UI's
native Genie Chart/Table renderer after Genie requested a chart.

## Validate feedback

```ts
import { feedback } from "@dbx-tools/shared-mastra";

const body = feedback.MastraFeedbackRequestSchema.parse({
  traceId: "tr-abc",
  value: true,
  comment: "Helpful",
});
```

Feedback constants include the MLflow trace header and default assessment names.
The schemas validate thumbs/comment payloads before they are sent to the plugin.

## Validate plugin responses

```ts
const chart = wire.ChartSchema.parse(await chartRes.json());
const event = wire.GenieWriterEventSchema.parse(writerPayload);
```

The `wire` module contains response schemas for suggestions, model lists,
charts, statement data, direct Genie threads/history, and Genie writer events.
It also defines the browser visualization payload consumed by AppKit UI.

## Package exports

- `wire`: Zod schemas and types for client config, model lists, suggestions,
  charts, statement data, and writer events.
- `routes`: plugin route segment constants and direct Genie route builder.
- `markers`: embed-marker parsing and incomplete-tail stripping.
- `feedback`: MLflow feedback headers, assessment names, request/response
  schemas.
- `override`: model override header/query/body constants.
- `thread`: thread ID header/query constants.
