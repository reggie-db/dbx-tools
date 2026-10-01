# @dbx-tools/shared-model

Browser-safe model-selection contracts generated from the Rust model owner.

Import this package when UI code, route handlers, tools, or tests need to
validate model lookup requests or type ranked model responses without talking to
Databricks. Rust owns normalization, classification, capability policy, ranking,
and fuzzy resolution through [`@dbx-tools/model`](../../node/model). The
handwritten browser classifier remains only as a deprecated compatibility API.

Key features:

- Rust-owned `ModelClass`, endpoint, query, status, profile, ranking, and
  reasoning-effort contracts generated as browser-safe TypeScript and zod.
- Deprecated classification, capability, and version helpers retained for
  compatibility while callers move to the classified server response.
- Human-readable endpoint display names via `display.toModelDisplayName`.
- OpenAI wire contracts and legacy TypeScript Chat/Responses adapters for routes
  and consumers that still need them.
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
picker; `name` stays the invoke id. A Databricks-provided name (a
`display_name`/`displayName`/`name` endpoint tag, or an external-model name
extracted in [`@dbx-tools/model`](../../node/model)'s `serving.ts`) wins;
otherwise the pure helper strips leading vendor prefixes and title-cases via
`@dbx-tools/shared-core`'s tokenizer. It flows through `GET /models`
automatically, and the UI picker shows `displayName ?? name`.

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

## Type Ranked Results

```ts
import { model, type RankedModel } from "@dbx-tools/shared-model";

const ranked: RankedModel = model.RankedModelSchema.parse(response);
```

`model.ServingEndpointSummarySchema` describes the stable endpoint fields exposed
to clients: endpoint name, parsed family, task, state, optional profile scores,
classified class, `supportsTools`, provider service names, Rust-derived
reasoning-effort wire values, lifecycle status, and embedding dimension.
`requiresTools: true` filters
search/ranking to endpoints that can complete both a function call and the
subsequent `function_call_output` replay.

## Use Classified Endpoint Catalogues

```ts
import { model } from "@dbx-tools/shared-model";

const fast = endpoints.filter((endpoint) => endpoint.class === model.ModelClass.ChatFast);
const agentModels = endpoints.filter((endpoint) => endpoint.supportsTools);
```

The server stamps class and capability fields through the Rust policy before it
returns `/models`. Prefer those fields directly. The `classify` calls above are
deprecated compatibility helpers for existing browser consumers and will be
removed in the next major release.

## Parse Model Families

```ts
const family = classify.classifyByFamily("databricks-claude-sonnet-4-6");
const version = classify.versionTuple("llama-3-1-70b");
```

These parsing helpers are deprecated. Server-side callers use
[`@dbx-tools/model`](../../node/model), which delegates family and version policy
to Rust; browser callers consume the classified response.

## Read Endpoint Capabilities

```ts
if (endpoint.class !== model.ModelClass.Embedding) offerInChatPicker(endpoint);
if (endpoint.supportsTools) offerInAgentPicker(endpoint);
```

`classify.endpointCapabilities` is retained for compatibility. New code reads
the Rust-stamped class and capability fields so every picker, CLI, and route
uses the same policy.

## Use The Legacy TypeScript Responses Adapters

```ts
import { openaiResponses } from "@dbx-tools/shared-model";

const { chat, stream } = openaiResponses.responsesToChat(requestBody);
// ... POST `chat` to the endpoint's invocations URL ...
const response = openaiResponses.chatToResponse(completion, modelId);
```

`openaiResponses` bridges Chat Completions and Responses in both directions for
TypeScript consumers, including a streaming translator
(`createResponsesStreamTranslator`) that lifts `chat.completion.chunk` SSE into
the Responses event stream, and `readResponsesOutput` for pulling the answer and
its citations back out of a native Responses reply. These are pure compatibility
helpers over plain JSON. The Rust model proxy uses the `aigw_*` adapters and
forwards native Responses input directly; it does not call this TypeScript
translator.

## Sanitize A Replayed Conversation

```ts
import { openaiResponses } from "@dbx-tools/shared-model";

const body = openaiResponses.sanitizeOpenResponsesRequest(requestBody);
```

`/open-responses` (the cross-provider path used for Claude and Gemini) rejects
content parts that its own previous turn produced: an `output_text` part replayed
as input fails with `Open Responses input content part type 'output_text' is not
supported`. `sanitizeOpenResponsesRequest` rewrites `output_*` parts back to their
`input_*` form and drops extended-thinking parts before the body goes out.

The thinking-block types live in one exported constant,
`openaiResponses.REASONING_TYPES`. Both wire sanitizers (this one and the Chat
Completions sanitizer in [`@dbx-tools/appkit-mastra`](../../node/appkit-mastra))
must strip exactly the same set: Anthropic signs `redacted_thinking` blocks, so a
replay in which one path mutates a block the other preserved is rejected
outright. Import the constant rather than re-listing the types.

## Strip Fields Databricks Rejects

```ts
import { openaiChat } from "@dbx-tools/shared-model";

const dropped = openaiChat.stripUnsupportedChatFields(body); // mutates `body`
```

Databricks Model Serving validates the chat body strictly: one unrecognized
top-level key fails the entire turn rather than being ignored. An OpenAI client
that sends `parallel_tool_calls` gets back
`parallel_tool_calls: Extra inputs are not permitted` and no completion at all.

`stripUnsupportedChatFields` deletes the known offenders in place and returns
what it removed, so a caller can log the difference. Reach for it on any path
that forwards a client body largely as-is; a translator that copies fields
one-by-one (`openaiResponses.responsesToChat`) already can't leak them. Pass
`extra` names to cover a workspace that rejects something not yet in
`openaiChat.UNSUPPORTED_CHAT_FIELDS`.

## Modules

- `model` - `ModelClass`, reasoning-effort wire schema, and inferred types for
  profiles, endpoint summaries, lookup requests, and ranked results.
- `classify` - deprecated family parsing, endpoint classification, and
  capability compatibility helpers.
- `display` - human-readable endpoint labels.
- `openaiChat` - Chat Completions message / tool-call types,
  `chatContentParts`, `chatContentToText`, and `stripUnsupportedChatFields`.
- `openaiResponses` - legacy TypeScript Responses adapters, plus
  `sanitizeOpenResponsesRequest` and the shared `REASONING_TYPES` constant.

Server-side selection, cache, and fuzzy endpoint matching are in
[`@dbx-tools/model`](../../node/model).
