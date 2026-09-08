# dbx-tools-model-proxy

Rust proxy between OpenAI or Anthropic clients and Databricks model-serving
protocols.

Install the public binary from crates.io:

```sh
cargo install dbx-tools-model-proxy
```

Release builds also publish `dbx-model-proxy` as a GitHub release asset for
each configured platform.

The prototype uses `aigw-openai` and `aigw-anthropic` as protocol adapters.
OpenAI Chat Completions and Anthropic Messages requests can target either
Databricks Chat Completions or Responses. Native Responses input currently
targets Responses without conversion.

Authentication comes from `dbx-tools-databricks`. The proxy resolves the
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

`--target responses` forces Chat Completions or Anthropic Messages input
through the Responses request translator. `--target chat` sends canonical
Chat Completions. `--target auto` selects Responses for Responses clients,
Codex models, and GPT 5.4 or newer.

Streaming requests use SSE without buffering the upstream response. Matching
protocols pass the upstream byte stream through directly, including Chat
Completions to Chat Completions and Responses to Responses for Codex clients.
Cross-protocol streams pass through aigateway's stateful Chat Completions or
Responses parser. Anthropic output uses aigateway's native SSE encoder, while
OpenAI Chat Completions output uses the prototype's canonical event encoder.

Responses input currently targets only Responses, so Responses-to-Chat
translation is outside this prototype's supported route matrix.
