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

## Authentication And Rate-Limit Identity

The binary creates one `DatabricksClient` at startup. That client owns upstream
authentication, while each incoming request supplies the principal used to
partition reactive rate-limit cooldowns. Identity selection never calls a
Databricks API:

- With `dbx model-proxy --profile PROFILE`, `dbx-tools-core` resolves that
  profile and uses its normal cached token lifecycle. U2M profiles use the
  Databricks CLI when available and may invoke login when renewal requires it.
  PAT and U2M requests key cooldowns by the profile name; the token itself is
  never part of the key.
- M2M profiles key cooldowns by OAuth client ID. Token refreshes can replace the
  access token without changing the rate-limit identity.
- In a Databricks App using App SP, startup resolves
  `DATABRICKS_HOST`, `DATABRICKS_CLIENT_ID`, and
  `DATABRICKS_CLIENT_SECRET`. The key is therefore the normalized App host,
  service-principal client ID, and resolved serving endpoint.
- Trusted `x-forwarded-user` and `x-forwarded-email` headers partition requests
  by App user. When those are absent, the proxy may decode `sub`, `user_id`,
  `oid`, `client_id`, `azp`, `email`, or `preferred_username` from an incoming
  bearer JWT without verifying it. This decode is only a local rate-limit
  partitioning hint and never authenticates the request.
- Forwarded OBO identity does not replace the startup client's upstream
  credential. The standalone binary has no request-scoped AppKit context, so
  automatic App startup normally resolves App SP. A host that needs true OBO
  upstream calls must construct request-scoped clients and pass the request
  headers through `DatabricksAuthOptions`.

The resulting key is `[normalized Databricks host, current principal, resolved
model]`. Different users, service principals, hosts, or serving endpoints never
share a cooldown. Keys are stored only in process memory, have no default count
limit, and disappear when the proxy exits.

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
streaming mode, status, latency, raw request bytes, a fast `tokenx-rs` token
estimate, and the immediate TCP peer IP and port without logging request bodies
or credentials. The peer can be a local or platform proxy rather than the end
user. Buffered responses also report upstream input, output, and total usage;
stream connection logs retain the preflight estimate without buffering SSE.

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
Unfiltered responses list chat/LLM families first and embedding families
second, alphabetically sorting families within each tier. Each family uses the
same version, variant, and class preference as a search for that family.
Recognized unclassified models remain in the chat/LLM tier. Custom and
unrecognized endpoints sort by name last. Codex priorities follow the resulting
order.

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
rate-limit headers, quota names, and Databricks limit details.

HTTP 429 responses pause the process-local host/principal/model gate described
above. One request probes after the shared cooldown while other streaming and
non-streaming requests for the same key remain paused. The `Retry-After`
response header controls the delay when present, followed by the documented
Foundation Model API `error.retry_after` JSON value. Otherwise the proxy uses
BackON jittered exponential delays from one second to one minute. Every 429
logs a returned `error.message`, including the final attempt. The default five
retries mean one initial request plus up to five retries.
After the final attempt, the original 429 status, body, and rate-limit headers
are returned to the caller. Configure `RATE_LIMIT_RETRIES`,
`RATE_LIMIT_INITIAL_DELAY_MS`, and `RATE_LIMIT_MAX_DELAY_MS`, or the matching
CLI flags. Set retries to `0` to disable both retries and coordinated cooldowns.
Only an initial HTTP 429 is retried; an SSE error after streaming begins cannot
be replayed safely.

The process-local token queue reads Databricks' published Enterprise
pay-per-token ITPM and OTPM limits from the same daily documentation cache and
generated-fallback pattern used for model capabilities and retirement status.
Input and output windows are tracked separately for each resolved model and
workspace. Requests reserve a `tokenx-rs` input estimate plus any explicit
`max_output_tokens`, `max_completion_tokens`, or `max_tokens` value. Claude
Sonnet 4 reserves its documented 1,000-token default when no output limit is
present.

Use `INPUT_TOKENS_PER_MINUTE` / `--input-tokens-per-minute` and
`OUTPUT_TOKENS_PER_MINUTE` / `--output-tokens-per-minute` to override the
published limits. Set `PROVISIONED_THROUGHPUT=true` or pass
`--provisioned-throughput` to disable both TPM windows. QPH remains enforced by
Databricks because process-local tracking cannot coordinate a workspace across
proxy replicas.
