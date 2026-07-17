# @dbx-tools/shared-mastra

Browser-safe contract for the AppKit Mastra plugin.

Import this package when a client, test, or server route needs the same route
constants, header names, embed-marker parsing, feedback schemas, thread
selection fields, and Mastra response schemas used by
[`@dbx-tools/appkit-mastra`](../../node/appkit-mastra).

Key features:

- Route constants for the AppKit-Mastra client surface, including history,
  threads, suggestions, model lists, embeds, and feedback.
- Header/query/body constants for thread selection and model override requests.
- Embed-marker parsing for delayed chart and statement-data payloads in
  streaming assistant text.
- Zod schemas for plugin-published client config and route responses.
- MLflow feedback request/response schemas and trace-header constants.
- Browser-safe types that let UI packages stay aligned with the server without
  importing Node or Mastra runtime code.

## Parse Client Configuration

```ts
import { wire } from "@dbx-tools/shared-mastra";

const config = wire.MastraClientConfigSchema.parse(await response.json());
```

`wire.MastraClientConfigSchema` describes the plugin-published client config:
mount path, default agent, feedback enablement, and MCP route details. Use it to
bootstrap a UI without hard-coding server paths.

## Use Route Constants

```ts
import { routes } from "@dbx-tools/shared-mastra";

const historyUrl = `${basePath}${routes.MASTRA_ROUTES.history}`;
const threadsUrl = `${basePath}${routes.MASTRA_ROUTES.threads}`;
```

`routes.MASTRA_ROUTES` keeps client fetch calls aligned with plugin route names
for history, threads, models, suggestions, feedback, and embeds.

## Select Threads And Models

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

## Parse Embed Markers

```ts
import { marker } from "@dbx-tools/shared-mastra";

const parts = marker.parseMarkers("Here is the chart:\n[chart:abc123]");
const safeText = marker.stripIncompleteMarkerTail(streamingText);
```

Markers let an agent mention large or delayed artifacts by id, such as
`[chart:<id>]` and `[data:<statement_id>]`. The parser is useful for rendering
assistant text while a stream is still arriving.

## Validate Feedback

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

## Validate Plugin Responses

```ts
const threads = wire.MastraThreadsResponseSchema.parse(await res.json());
const chart = wire.ChartSchema.parse(await chartRes.json());
const event = wire.GenieWriterEventSchema.parse(writerPayload);
```

The `wire` module contains response schemas for history, threads, suggestions,
model lists, charts, statement data, and Genie writer events. It also defines the
chart/data result shapes consumed by embed renderers.

## Modules

- `wire` - zod schemas and types for client config, history, threads, model
  lists, suggestions, charts, statement data, and writer events.
- `routes` - plugin route segment constants.
- `marker` - embed-marker parsing and incomplete-tail stripping.
- `feedback` - MLflow feedback headers, assessment names, request/response
  schemas.
- `override` - model override header/query/body constants.
- `thread` - thread id header/query constants.

Server-side implementation is in
[`@dbx-tools/appkit-mastra`](../../node/appkit-mastra).
