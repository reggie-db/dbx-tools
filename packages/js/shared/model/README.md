# @dbx-tools/shared-model

Validate model lookups and ranked model responses in UIs, routes, tools, and
tests without importing Databricks clients. Use the browser-safe model
selection, capability, reasoning, and OpenAI Chat Completions contracts across
client and server boundaries.
Server-side normalization, classification, ranking, and fuzzy resolution live in
[@dbx-tools/model](../../node/model).

## Format model display names

```ts
import { display } from "@dbx-tools/shared-model";

display.toModelDisplayName("databricks-claude-sonnet-4-6"); // "Claude Sonnet 4.6"
display.toModelDisplayName("system.ai.bge_large_en"); // "BGE Large En"
display.toModelDisplayName("x", "Claude 4.6 (Preview)"); // provided name wins
```

`ServingEndpointSummary.displayName` is the optional friendly label for the
picker. `name` stays the invocation ID. A Databricks-provided name wins. Otherwise,
the pure helper strips leading vendor prefixes and title-cases through
`@dbx-tools/shared-core`'s tokenizer.

The package also includes generated `ModelClass`, endpoint, query, status,
profile, ranking, and reasoning-effort contracts, plus browser-safe OpenAI Chat
Completions message and tool-call contracts.

## Validate a model lookup request

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

## Use classified endpoint catalogs

```ts
import { model } from "@dbx-tools/shared-model";

const fast = endpoints.filter((endpoint) => endpoint.class === model.ModelClass.ChatFast);
const agentModels = endpoints.filter((endpoint) => endpoint.supportsTools);
```

The server stamps class and capability fields before returning `/models`.
Browser clients consume those fields directly. Model-family policy does not run
in the browser.

## Strip fields that Databricks rejects

```ts
import { openaiChat } from "@dbx-tools/shared-model";

const dropped = openaiChat.stripUnsupportedChatFields(body);
```

Databricks Model Serving validates Chat Completions bodies strictly.
`stripUnsupportedChatFields` deletes known unsupported fields in place and
returns the removed names so a caller can log the difference.

## Runtime boundary

This package doesn't discover endpoints, read credentials, rank models, or send
Model Serving requests. Use [@dbx-tools/model](../../node/model) for
server-side model discovery and selection. Use
[@dbx-tools/shared-model-gateway](../model-gateway) for browser-safe model
gateway responses and discovery clients.

## Package exports

- `model`: model classes, reasoning-effort schema, endpoint summaries, lookup
  requests, and ranked results.
- `display`: human-readable endpoint labels.
- `openaiChat`: Chat Completions message and tool-call types, content helpers,
  and rejected-field sanitization.
