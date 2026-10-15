# Connect model clients to Databricks

Use the model gateway when an OpenAI, Anthropic, embedding, or Codex client must
call models available in a Databricks workspace.

## Choose a gateway mode

Use the foreground CLI for one local session:

```bash
dbx model-gateway \
  --profile <profile> \
  --listen tcp://127.0.0.1:4000
```

Install the current-user service when local tools need the endpoint after the
terminal closes:

```bash
dbx model-gateway service install --profile <profile>
dbx model-gateway service status
```

Register the AppKit plugin when model routes belong to a Databricks App:

```ts
import { server } from "@databricks/appkit";
import { appkit } from "@dbx-tools/appkit";
import { modelGateway } from "@dbx-tools/appkit-model-gateway";

await appkit.createApp({
  plugins: [server(), modelGateway()],
});
```

The standalone base URL is [http://127.0.0.1:4000/v1](http://127.0.0.1:4000/v1).
The default embedded
base path is `/api/model-gateway/v1`.

## Call an OpenAI-compatible route

List models:

```bash
curl http://127.0.0.1:4000/v1/models
```

Send a Responses request:

```bash
curl http://127.0.0.1:4000/v1/responses \
  -H 'content-type: application/json' \
  -H 'x-dbx-tools-model-class: chat-balanced' \
  -d '{
    "input": "Explain this repository in three sentences."
  }'
```

The gateway resolves loose model names and capability classes against the live
workspace catalogue. An exact serving endpoint or `system.ai.*` service name
wins over automatic selection.

## Use Anthropic, embeddings, or Codex

The gateway also serves:

- Anthropic Messages.
- OpenAI-compatible embeddings.
- Codex model discovery and Responses traffic.
- OpenAI Chat Completions.

Configure Codex with `wire_api = "responses"` and
`supports_websockets = false`. Codex requests advertise their client identity
and receive a compatible model catalogue.

## Choose model policy

Use `model` for an exact or fuzzy name. Use `modelClass` for a capability band
such as `chat-fast` or `chat-thinking`.

Set `preferSystemModels` or pass `--prefer-system-models` to prefer eligible
`system.ai.*` services for non-exact Responses requests. Exact names remain
authoritative.

Use model overrides only to correct workspace metadata for a known model. For
example, disable web search when the selected gateway route cannot use an
advertised capability.

## Understand protocol limits

The gateway uses direct streaming when the selected model supports the client
protocol. It uses Vercel AI SDK translation when protocols differ.

The Responses API rejects stateful options that cannot be preserved, including
`previous_response_id`, `store: true`, and `background: true`.

Web search and custom tools require a model that advertises the corresponding
capability.

## <a id="additional-resources"></a> Additional resources

- [@dbx-tools/appkit-model-gateway](../packages/js/node/appkit-model-gateway/README.md)
- [@dbx-tools/shared-model-gateway](../packages/js/shared/model-gateway/README.md)
- [@dbx-tools/model](../packages/js/node/model/README.md)
- [@dbx-tools/cli](../packages/js/cli/dbx-tools/README.md)
