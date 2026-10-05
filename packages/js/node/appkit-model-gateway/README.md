# @dbx-tools/appkit-model-gateway

Raw AppKit plugin for OpenAI, Anthropic, Codex, and Databricks AI Gateway model
traffic.

The gateway discovers the active workspace model catalogue dynamically through
`@dbx-tools/model`. AppKit supplies the service-context Databricks client and
`@dbx-tools/auth` resolves its standard workspace profile and token lifecycle.

## AppKit plugin

```ts
import { createApp, server } from "@databricks/appkit";
import { modelGateway } from "@dbx-tools/appkit-model-gateway";

await createApp({
  plugins: [modelGateway(), server()],
});
```

AppKit mounts the plugin routes under `/api/model-gateway/v1/*`. The
`@dbx-tools/cli-model-gateway` package owns foreground server construction and
standard root compatibility paths.

## Routing

Responses requests use direct streaming paths in this order:

1. `/serving-endpoints/responses` for native OpenAI Responses models.
2. `/ai-gateway/codex/v1/responses` for compatible model services such as Grok.
3. `/serving-endpoints/open-responses` for remaining cross-provider models.
4. Vercel AI SDK ProviderV4 translation when the caller and model protocols do
   not match.

Chat Completions use `/serving-endpoints/chat/completions`. Native Claude
Messages use `/serving-endpoints/anthropic/v1/messages`.
Embeddings use the resolved endpoint's `/invocations` path.

Direct paths do not decode or rebuild successful response streams. They preserve
upstream SSE framing, backpressure, and cancellation. Translation paths use
`@ai-sdk/open-responses`, `@ai-sdk/openai-compatible`, or
`@ai-sdk/anthropic` for provider wire behavior and encode the requested client
protocol as events arrive.

The gateway rejects stateful Responses options it cannot preserve, including
`previous_response_id`, `store: true`, and `background: true`.

## Codex

`GET /v1/models` includes Codex metadata when the request carries
`Originator: codex`. Codex slugs prefer fully qualified Databricks model service
names, which activates the Unity Gateway fast path.

Point a Codex provider at:

```text
http://127.0.0.1:4000/v1
```

Use `wire_api = "responses"` and `supports_websockets = false`.

Browser applications can use `@dbx-tools/shared-model-gateway` to search and
schema-validate model lists without importing Node or AppKit code.
