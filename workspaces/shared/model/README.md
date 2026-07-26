# @dbx-tools/shared-model

Browser-safe model-selection contract and classifier.

Import this package when UI code, route handlers, tools, or tests need to
validate model lookup requests, type ranked model responses, or classify serving
endpoints without talking to Databricks. Live workspace listing and fuzzy
resolution live in [`@dbx-tools/model`](../../node/model).

Key features:

- Shared `ModelClass` taxonomy for chat-thinking, chat-balanced, chat-fast, and
  embedding workloads.
- Browser-safe zod schemas for lookup requests, endpoint summaries, ranked
  results, and profile metadata.
- Endpoint classifier that groups serving endpoints by score profile and family
  naming conventions, plus `classify.endpointCapabilities` for chat / embedding
  / tool-calling capability flags.
- Version/family parsing helpers for model catalogues and tests.
- Human-readable endpoint display names via `display.toModelDisplayName`.
- OpenAI wire contracts: chat message/tool-call types plus a Responses API
  translator, so a proxy, a route, and a UI all speak the same payload shapes.
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
`display_name`/`displayName`/`name` endpoint tag, or an external-model name —
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
to clients: endpoint name, task, state, optional profile scores, classified
class, and embedding dimension.

## Classify Endpoint Catalogues

```ts
import { classify, model } from "@dbx-tools/shared-model";

const byClass = classify.classifyEndpoints(endpoints);
const fast = byClass[model.ModelClass.ChatFast];
```

The classifier uses Foundation Model API quality/speed/cost scores when present
and family-name heuristics when scores are missing. This is useful for client
grouping, tests, and offline catalogue analysis.

## Parse Model Families

```ts
const family = classify.classifyByFamily("databricks-claude-sonnet-4-6");
const version = classify.versionTuple("llama-3-1-70b");
```

Family parsing helps callers bucket custom lists or explain why an endpoint
landed in a class before the live workspace scores are available.

## Ask What An Endpoint Can Do

```ts
const caps = classify.endpointCapabilities(endpoint);
if (caps.chat) offerInChatPicker(endpoint);
```

Capability comes from the Databricks task hint (`llm/v1/chat` /
`llm/v1/embeddings`) with the classified class as the fallback for endpoints
Databricks left untagged. Filter on this rather than comparing raw `task`
strings, so every picker, CLI, and route agrees on what "chat-capable" means.

## Translate The OpenAI Responses API

```ts
import { openaiResponses } from "@dbx-tools/shared-model";

const { chat, stream } = openaiResponses.responsesToChat(requestBody);
// ... POST `chat` to the endpoint's invocations URL ...
const response = openaiResponses.chatToResponse(completion, modelId);
```

Databricks serving endpoints speak Chat Completions; some clients (the Codex
CLI, for one) speak only the Responses API. `openaiResponses` bridges the two in
both directions, including a streaming translator
(`createResponsesStreamTranslator`) that lifts `chat.completion.chunk` SSE into
the Responses event stream, and `readResponsesOutput` for pulling the answer and
its citations back out of a native Responses reply. Pure functions over plain
JSON, so the same translation runs in a proxy, a server route, or a test.

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

- `model` - `ModelClass`, zod schemas, and inferred types for profiles,
  endpoint summaries, lookup requests, and ranked results.
- `classify` - family parsing, version tuple parsing, endpoint classification,
  and capability flags.
- `display` - human-readable endpoint labels.
- `openaiChat` - Chat Completions message / tool-call types,
  `chatContentToText`, and `stripUnsupportedChatFields`.
- `openaiResponses` - Responses API translation in both directions, plus
  `sanitizeOpenResponsesRequest` and the shared `REASONING_TYPES` constant.

Server-side selection, cache, and fuzzy endpoint matching are in
[`@dbx-tools/model`](../../node/model).
