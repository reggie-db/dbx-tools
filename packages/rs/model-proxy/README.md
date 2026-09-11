# dbx-tools-model-proxy

Rust proxy between OpenAI or Anthropic clients and Databricks Model Serving
protocols.

Install and run the version-matched release binary through `dbx`:

```sh
dbx model-proxy --profile PROFILE
```

The first invocation downloads the GitHub release asset matching the installed
`@dbx-tools/cli` version and host platform. Later invocations reuse the
validated executable.

The public crate can also be installed from crates.io:

```sh
cargo install dbx-tools-model-proxy
```

Release builds also publish `dbx-model-proxy` as a GitHub release asset for
each configured platform.

The proxy uses `aigw-openai` and `aigw-anthropic` as protocol adapters.
OpenAI Chat Completions and Anthropic Messages requests can target either
Databricks Chat Completions or Responses. Native Responses input currently
targets Responses without conversion.

Authentication comes from `dbx-tools-core`. The proxy resolves the
selected Databricks profile, obtains cached or refreshed credentials, and
retries one upstream `401` after refreshing the rejected token.
`dbx-tools-model` discovers the workspace's serving endpoints, caches the
catalogue for five minutes, and resolves loose model values before forwarding.
For example, `"model": "gpt"` selects the highest-ranked deployed GPT model.

## Run

```sh
cargo run --manifest-path packages/rs/model-proxy/Cargo.toml -- \
  --profile PROFILE --target auto
```

The server listens on `127.0.0.1:4000` by default. `--port` reads
`DATABRICKS_APP_PORT` when present.

Request bodies default to 25 MB through `--max-request-bytes` /
`MAX_REQUEST_BYTES`. Embedded JPEG, PNG, and WebP inputs are detected from their
bytes across OpenAI Chat, Responses, and Anthropic base64 shapes. Images larger
than 2 MB are re-encoded and resized proportionally to at most a 1,568-pixel
edge and 1.15 megapixels before protocol translation. Images at or below 2 MB
and remote image URLs are unchanged, and the proxy never fetches image URLs
itself. Set `--image-resize-threshold-bytes` or
`IMAGE_RESIZE_THRESHOLD_BYTES` to change the size threshold.

`LOG_LEVEL` accepts `debug`, `info`, `warn`, or `error`, case-insensitively,
and defaults to `info`. Request summaries include protocol, selected model,
streaming mode, status, and latency without logging request bodies or tokens.

Import `postman/model-proxy.postman_collection.json` into Postman. The
collection has separate folders for `--target chat` and `--target responses`;
restart the proxy with the folder's documented command before running it. Set
`chatModel` and `responsesModel` to endpoints available in the selected
workspace.

Supported routes:

- `GET /v1/models`
- `POST /v1/embeddings`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/messages`
- `GET /healthz`

`GET /v1/models` reads the cached live serving-endpoint catalogue. Standard
requests receive an OpenAI `object` / `data` envelope. An `originator` header
whose value starts with `codex` receives a Codex `models` envelope. Both use
the identities returned by Databricks directly: OpenAI uses the serving
endpoint name, while Codex maps `databricks-<model>` to the gateway's
`system.ai.<model>` identity. No `databricks/` or `dbx/` namespace is added.

Use `?search=gpt` to apply the same fuzzy scoring and ordering as model
resolution. Add `?extended=true` to include the score, service names,
capability class, profile, task, state, and other catalogue metadata. Extended
output defaults to `false`.

`POST /v1/embeddings` resolves the requested model only among deployed
embedding endpoints, forwards the request to that endpoint's `invocations`
route, and preserves the OpenAI embedding response.

`--target responses` forces Chat Completions or Anthropic Messages input
through the Responses request translator. `--target chat` sends canonical
Chat Completions. `--target auto` selects Responses for Responses clients,
models listed by the current Databricks Responses documentation, Codex clients,
and requests containing Responses-only hosted tools or conversation fields.

Native Responses requests are forwarded without a capability allow-list, so
Databricks-supported `function`, `custom`, `apply_patch`, `shell`,
`image_generation`, `mcp`, and `web_search` tools, image inputs, conversation
state, background mode, and future request fields remain intact. Chat and
Anthropic image blocks are translated to Responses `input_image` content.
Chat-hosted tools are preserved in Responses form instead of being rejected as
malformed function tools. A forced `--target chat` returns a clear client error
for Responses-only features rather than silently dropping them.

Codex model records obtain image-input, web-search, and patch capability sets
from the corresponding Databricks documentation pages. The parsed model lists
are cached for one day and matched against endpoint, model-service, and provider
identities from the live workspace catalogue. The same parser generates a
committed snapshot during repository synthesis, and the binary embeds that
snapshot as its offline fallback. A failed page refresh retains the matching
capabilities from the embedded snapshot without blocking model listing. This
avoids embedding a handwritten model/version matrix while still using the
unified local execution tool shape expected by current Codex clients.

Streaming requests use SSE without buffering the upstream response. Matching
protocols pass the upstream byte stream through directly, including Chat
Completions to Chat Completions and Responses to Responses for Codex clients.
Cross-protocol streams pass through aigateway's stateful Chat Completions or
Responses parser. Anthropic output uses aigateway's native SSE encoder, while
OpenAI Chat Completions output uses the proxy's canonical event encoder.

Responses input currently targets only Responses, so Responses-to-Chat
translation is outside the supported route matrix.

Databricks errors are returned with their original status, body, and content
type. The proxy also forwards `Retry-After`, request and correlation IDs,
rate-limit headers, quota names, and Databricks limit details. It does not retry
rate-limited requests; clients such as Codex retain control of retry timing.

The local token queue is disabled by default. Databricks publishes different
input and output token limits for each pay-per-token model, while provisioned
endpoints use allocated capacity. Codex limits vary by account tier. There is
no single documented value that is correct for every routed model.

Set `TOKENS_PER_MINUTE` or pass `--tokens-per-minute` to enable an explicit
combined budget. The configured budget applies independently to each resolved
model in each Databricks workspace. Requests reserve an estimated input token
count plus any explicit `max_output_tokens`, `max_completion_tokens`, or
`max_tokens` value before they are sent upstream.
