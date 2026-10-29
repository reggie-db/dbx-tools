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

## Understand request parameter translation

The gateway translates parameters only when it has provider-safe metadata or a
specific Databricks error response. Unknown custom endpoints keep valid numeric
sampling values unchanged.

### Temperature translation

The following flow shows how the gateway handles `temperature`.

```mermaid
flowchart TD
    accTitle: Temperature translation
    accDescr: The gateway preserves omitted and unknown numeric temperatures, removes null and unsupported temperatures, rejects invalid values, and clamps supported Databricks values.
    start["Receive temperature"] --> present{"Is the field present?"}
    present -->|No| unchanged["Leave the request unchanged"]
    present -->|Yes| null{"Is the value null?"}
    null -->|Yes| remove["Remove temperature"]
    null -->|No| finite{"Is the value a finite number?"}
    finite -->|No| invalid["Return HTTP 400"]
    finite -->|Yes| metadata{"Does the Databricks model have models.dev metadata?"}
    metadata -->|No| preserve["Preserve the numeric value"]
    metadata -->|Yes| supported{"Does the model support temperature?"}
    supported -->|No| remove
    supported -->|Yes| clamp["Clamp the value to 0 through 2"]
```

Temperature support comes from the Databricks provider records in the committed
models.dev snapshot. The daily metadata refresh keeps the previous cached or
committed snapshot when models.dev is unavailable.

### Reasoning translation

The following flow shows how the gateway maps reasoning effort and retries a
Databricks request.

```mermaid
flowchart TD
    accTitle: Reasoning effort translation
    accDescr: The gateway normalizes reasoning effort, selects the first available supported ladder, scales down to a supported level, and retries once after a reasoning-specific Databricks error.
    start["Read reasoning_effort or reasoning.effort"] --> normalize["Normalize a known level or alias"]
    normalize --> valid{"Is the normalized level valid?"}
    valid -->|No, null, or none| centered["Use a medium-centered request"]
    valid -->|Yes| ladder["Select the first available supported ladder"]
    ladder --> docs["1. Databricks documentation"]
    docs --> params["2. modelparams.dev effort enums"]
    params --> learned["3. Learned Databricks error values"]
    learned --> family["4. Model family fallback"]
    family --> scale["Scale down to the nearest supported level"]
    centered --> scale
    scale --> send["Send the Databricks request"]
    send --> rejected{"Does Databricks reject reasoning?"}
    rejected -->|No| response["Return the response"]
    rejected -->|Lists supported values| learn["Learn the values and retry once"]
    rejected -->|Does not support reasoning| strip["Remove reasoning fields and retry once"]
```

The reasoning ladder uses Databricks documentation first, then modelparams.dev
effort enums, learned Databricks error values, and family defaults. A
provider-specific boolean such as Qwen `enable_thinking` does not define a
generic effort ladder. If Databricks reports that the model does not support the
reasoning field, the gateway removes the field and retries once.

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
