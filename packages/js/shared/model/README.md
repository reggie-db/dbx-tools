# @dbx-tools/shared-model

Browser-safe model-selection contracts generated from the canonical model
owner.

Import this package when UI code, route handlers, tools, or tests need to
validate model lookup requests or type ranked model responses without talking
to Databricks. Normalization, classification, capability policy, ranking, and
fuzzy resolution are exposed through [`@dbx-tools/model`](../../node/model).

Key features:

- Generated `ModelClass`, endpoint, query, status, profile, ranking, and
  reasoning-effort contracts as browser-safe TypeScript and zod.
- Human-readable endpoint display names via `display.toModelDisplayName`.
- Browser-safe OpenAI Chat message and tool-call contracts.
- Types that match the server selection API without depending on the Databricks
  SDK.

## Human-Readable Display Names

```ts
import { display } from "@dbx-tools/shared-model";

display.toModelDisplayName("databricks-claude-sonnet-4-6"); // "Claude Sonnet 4.6"
display.toModelDisplayName("system.ai.bge_large_en"); // "BGE Large En"
display.toModelDisplayName("x", "Claude 4.6 (Preview)"); // provided name wins
```

`ServingEndpointSummary.displayName` is the optional friendly label for the
picker; `name` stays the invoke id. A Databricks-provided name wins. Otherwise,
the pure helper strips leading vendor prefixes and title-cases through
`@dbx-tools/shared-core`'s tokenizer.

## Validate A Model Lookup Request

```ts
import { model } from "@dbx-tools/shared-model";

const query = model.ModelQuerySchema.parse({
  search: "claude sonnet",
  modelClass: "chat-balanced",
  requiresTools: true,
  limit: 5,
});
```

Use `model.ModelQuerySchema` for route query/body validation and agent tool
inputs. It keeps client model pickers and backend resolution endpoints on the
same request shape.

## Use Classified Endpoint Catalogues

```ts
import { model } from "@dbx-tools/shared-model";

const fast = endpoints.filter((endpoint) => endpoint.class === model.ModelClass.ChatFast);
const agentModels = endpoints.filter((endpoint) => endpoint.supportsTools);
```

The server stamps class and capability fields before returning `/models`.
Browser clients consume those fields directly; model-family policy does not run
in the browser.

## Strip Fields Databricks Rejects

```ts
import { openaiChat } from "@dbx-tools/shared-model";

const dropped = openaiChat.stripUnsupportedChatFields(body);
```

Databricks Model Serving validates Chat Completions bodies strictly.
`stripUnsupportedChatFields` deletes known unsupported fields in place and
returns the removed names so a caller can log the difference.

## Modules

- `model` - model classes, reasoning-effort schema, endpoint summaries, lookup
  requests, and ranked results.
- `display` - human-readable endpoint labels.
- `openaiChat` - Chat Completions message and tool-call types, content helpers,
  and rejected-field sanitization.

Server-side selection, cache, and fuzzy endpoint matching are in
[`@dbx-tools/model`](../../node/model).
