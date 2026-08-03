# dbx-tools-model-proxy

Local OpenAI-compatible proxy for Databricks Model Serving.

Import this package or run its CLI when a tool expects the OpenAI API shape but
you want Databricks Model Serving auth, endpoint discovery, and fuzzy model
names. Chat/completions and embeddings bodies are forwarded verbatim: the proxy
resolves the requested model, mints/refreshes Databricks auth through the SDK,
and streams the upstream response back to the caller.

Key features:

- OpenAI-compatible `/v1/*` forwarding for local tools that already know how to
  call chat/completions endpoints.
- `POST /v1/responses` support for clients that speak only the OpenAI Responses
  API (the Codex CLI, for one), forwarded to Databricks' native Responses/Open
  Responses surface with JSON and SSE preserved.
- Databricks SDK auth, including profile selection, token refresh, and workspace
  host resolution.
- Fuzzy model names and model-class requests powered by
  [`@dbx-tools/model`](../../node/model).
- Optional local API-key enforcement for loopback safety.
- One-shot terminal chat mode that injects `OPENAI_BASE_URL`, `OPENAI_API_KEY`,
  and `OPENAI_MODEL` into a child process.
- Programmatic Express app/server creation for tests and custom developer tools.

## Why Not Just AppKit Serving?

Use native AppKit Serving routes inside a Databricks App. They preserve AppKit's
plugin lifecycle, OBO request context, generated types, and React hooks.

Use this proxy for local tools that already speak the OpenAI API shape and know
nothing about AppKit:

- terminal chat clients and IDE integrations that only accept `OPENAI_BASE_URL`;
- local experiments where Databricks SDK auth should mint the upstream token;
- loose model names resolved through `@dbx-tools/model`;
- test harnesses that need an Express server with Databricks-backed `/v1/*`
  routes.

## Run The Proxy

```sh
dbx-tools-model-proxy --profile my-workspace --port 4000
```

The package installs two equivalent commands: `dbx-tools-model-proxy` and the
shorter `dbxt-model-proxy`. Neither matches the package name, so a one-off run
has to name the command explicitly:

```sh
npx --package @dbx-tools/cli-model-proxy dbx-tools-model-proxy
```

Then point any OpenAI-compatible client at `http://127.0.0.1:4000/v1`:

```sh
curl http://127.0.0.1:4000/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"claude sonnet","messages":[{"role":"user","content":"hi"}]}'
```

The response includes `x-resolved-model`, showing which Databricks serving
endpoint the loose request snapped to.

The proxy is intentionally local-first. Bind it to `127.0.0.1` unless you are
putting another trusted access-control layer in front of it.

## Use A Terminal Chat Client

```sh
dbx-tools-model-proxy chat --profile my-workspace --model "claude sonnet"
dbx-tools-model-proxy chat --client "aichat" --model "chat fast"
```

`chat` starts the proxy, sets `OPENAI_BASE_URL`, `OPENAI_API_KEY`, and
`OPENAI_MODEL` for the child process, then shuts the proxy down when the child
exits. Use it to try Databricks-hosted models in any OpenAI-compatible terminal
client without editing that client's config.

## Inspect Model Resolution

```sh
dbx-tools-model-proxy models --profile my-workspace
dbx-tools-model-proxy resolve claude sonnet --profile my-workspace
```

These commands are useful when a client request resolves unexpectedly. They use
the same backend and resolver as the proxy server (`@dbx-tools/model`
`rankModels`: Fuse match, then class, then within-class version - so `opus`
prefers `opus-5` over `opus-4-7`).

## Require A Client API Key

```sh
dbx-tools-model-proxy --api-key "$LOCAL_PROXY_KEY"
```

With `--api-key` or `PROXY_API_KEY`, callers must send
`Authorization: Bearer <key>`. This protects the loopback proxy when another
local process may be able to reach it.

## Start Programmatically

```ts
import { backend, server } from "@dbx-tools/cli-model-proxy";

const db = await backend.DatabricksBackend.create({
  profile: "my-workspace",
  fuzzyThreshold: 0.35,
});

const running = await server.startProxyServer(db, {
  host: "127.0.0.1",
  port: 4000,
  apiKey: process.env.LOCAL_PROXY_KEY,
});

console.log(running.url);
```

Use this when tests or local developer tools need a managed proxy lifecycle.
`server.createProxyServer()` returns the Express app without binding a port.

## How Requests Flow

1. `backend.DatabricksBackend` reads the OpenAI request body and resolves
   `body.model` through [`@dbx-tools/model`](../../node/model).
2. Request fields Databricks refuses to parse are dropped (see below).
3. The Databricks SDK supplies a fresh authorization header for the workspace.
4. The proxy picks the upstream URL:
   - Chat Completions → `/serving-endpoints/<name>/invocations`, except
     Responses-only models (Codex) which are translated and posted to
     `/serving-endpoints/responses`.
   - Responses → `/serving-endpoints/responses` (OpenAI-family) or
     `/serving-endpoints/open-responses` (Claude/Gemini/…). For Open
     Responses the proxy strips non-`function` tools, rewrites prior-turn
     `output_*` content parts to `input_*`, and drops Claude
     `thinking` / `redacted_thinking` / `reasoning` blocks (replay of those
     signed blobs fails with "Invalid `data` in `redacted_thinking`").
5. JSON or SSE response bodies are piped back (with a chat↔Responses
   translation only when a chat client hit a Responses-only model).

This keeps the package small: Databricks already speaks the OpenAI schema, so
the useful work is auth, endpoint resolution, and routing to the right surface.

## Function Tools And Queue-Status Readiness

The proxy preserves Responses function tools, function-call output items,
streaming function-call events, and stateless tool-result replay. Requests that
carry `tools` are resolved only against models with `capabilities.tools: true`;
Codex's `?client_version=...` model catalogue also excludes unsupported models.

Databricks does not currently advertise tool support in endpoint list/OpenAPI
metadata, so the capability is a conservative policy verified live on the
`DEFAULT` profile:

- Full call and result replay: GPT/Codex, Claude, Qwen, GLM, Llama.
- Excluded: Gemini, because replayed function calls require a thought signature
  that Open Responses does not currently accept.
- Excluded: GPT-OSS, because Databricks rejects Responses passthrough for it.

Create a call with a dummy queue tool:

```sh
curl -s http://127.0.0.1:4000/v1/responses \
  -H "Authorization: Bearer $DBX_MODEL_PROXY_KEY" \
  -H "content-type: application/json" \
  -d '{
    "model": "databricks-gpt-5-3-codex",
    "input": "Call queue_status before responding.",
    "tools": [{
      "type": "function",
      "name": "queue_status",
      "description": "Check whether user messages are queued",
      "parameters": {
        "type": "object",
        "properties": {},
        "additionalProperties": false
      }
    }],
    "tool_choice": {"type": "function", "name": "queue_status"}
  }'
```

Databricks rejects `previous_response_id`, so replay the returned function call
and its result together in the next request:

```sh
curl -s http://127.0.0.1:4000/v1/responses \
  -H "Authorization: Bearer $DBX_MODEL_PROXY_KEY" \
  -H "content-type: application/json" \
  -d '{
    "model": "databricks-gpt-5-3-codex",
    "input": [
      {
        "type": "message",
        "role": "user",
        "content": "Call queue_status, then report queued work."
      },
      {
        "type": "function_call",
        "name": "queue_status",
        "call_id": "<call_id from the first response>",
        "arguments": "{}"
      },
      {
        "type": "function_call_output",
        "call_id": "<same call_id>",
        "output": "{\"queued\":true,\"count\":2}"
      }
    ]
  }'
```

Add `"stream": true` to the first request to receive
`response.output_item.added`, `response.function_call_arguments.delta`, and
`response.output_item.done` events unchanged.

## Timeouts And Cancellation

A proxied turn takes as long as the model behind it, so the proxy imposes **no
deadline of its own** in either direction. The stream ends when Databricks ends
it, or when the client hangs up.

That is a deliberate override of two sets of defaults that otherwise truncate
long turns:

- **Inbound** (client → proxy). Node's `requestTimeout` (300s) and
  `headersTimeout` (60s) are sized for ordinary web traffic, not for holding a
  streamed model response open. Both are set to `0`.
- **Upstream** (proxy → Databricks). Every upstream call goes out on an
  `undici` `Agent` with `headersTimeout: 0` and `bodyTimeout: 0`. `bodyTimeout`
  is the important one: it measures the gap **between** chunks, so its 300s
  default fires on a model that pauses mid-stream - extended reasoning, a long
  tool round trip, a slow Genie or SQL step - and tears the socket down with
  `UND_ERR_BODY_TIMEOUT`. The client sees a stream that simply stops.

Because nothing times out, client disconnect is the backstop: each upstream
request carries an `AbortSignal` tied to the response, so a cancelled turn
(Ctrl-C, a closed tab, a killed CLI) releases the Databricks-side stream instead
of leaking it. If a turn should have a deadline, send one from the client - the
same as you would to OpenAI.

An upstream failure that happens _after_ the response headers are sent is
logged (`stream ended early`) rather than thrown, since the status line is
already committed and cannot be turned into an HTTP error.

## Rate Limits And 429 Backoff

Databricks Foundation Model endpoints are pay-per-token with an account-level
throughput ceiling. That ceiling is **not** exposed as a readable number, so the
proxy cannot pace against it in advance - it can only react. An agentic client
that bursts (Codex, for one) trips the limit and, left alone, retries a few
times and gives up with "exceeded retry limit".

So **by default the proxy absorbs the `429` itself**: instead of relaying it, it
retries the upstream call in-proxy with exponential backoff and up to +50%
jitter, honoring a server-sent `Retry-After` when present. Because the retry
happens before any status line is written, it is transparent to both streaming
and non-streaming callers - the client sees a slower success, not a 429. A fresh
auth header is minted per attempt so a long backoff can't outlive the token, and
a client disconnect during a backoff ends the wait immediately.

Retries are exhausted after `maxRetries` attempts, at which point the final 429
is relayed unchanged.

Disable it (relay 429s straight through) with the flag or the env var:

```sh
dbx-tools-model-proxy --no-retry-429
PROXY_RETRY_ON_429=false dbx-tools-model-proxy
```

Tune the policy with environment variables (all optional):

| Variable              | Default | Meaning                                                                               |
| --------------------- | ------- | ------------------------------------------------------------------------------------- |
| `PROXY_RETRY_ON_429`  | `true`  | Master switch (loose boolean: `false`/`off`/`0`/`no`). `--no-retry-429` overrides it. |
| `PROXY_RETRY_MAX`     | `5`     | Max retry attempts after the initial try.                                             |
| `PROXY_RETRY_BASE_MS` | `500`   | First backoff, doubled each attempt.                                                  |
| `PROXY_RETRY_MAX_MS`  | `30000` | Ceiling for any single backoff, including a `Retry-After`.                            |

Precedence is CLI flag → env → built-in default.

## Unsupported Request Fields

Databricks Model Serving validates the chat body strictly, so a single
top-level key it doesn't recognize fails the whole turn:

```json
{ "error_code": "BAD_REQUEST", "message": "parallel_tool_calls: Extra inputs are not permitted" }
```

Because `/v1/chat/completions` forwards the client's body as-is, the proxy
deletes the known offenders first - `parallel_tool_calls` plus OpenAI-platform
bookkeeping like `store` and `metadata` - using
`openaiChat.stripUnsupportedChatFields` from
[`@dbx-tools/shared-model`](../../shared/model). Anything dropped is named in
the `proxy` log line. `/v1/responses` is a native passthrough to Databricks'
Responses / Open Responses surface, so these chat-only field drops do not apply.

Set `PROXY_DROP_FIELDS` to a comma-separated list to drop more, when a
workspace or a new client version trips a field this package doesn't know
about yet:

```sh
PROXY_DROP_FIELDS=some_new_field,another dbx-tools-model-proxy
```

## Modules

- `cli` - Commander program and `runCli()`.
- `backend` - `DatabricksBackend`, auth, model resolution, and upstream request
  forwarding.
- `server` - Express proxy app and `startProxyServer()`.
- `defaults` - bind host, port, and the 429-retry policy (`resolveRetryConfig`).

Endpoint ranking and fuzzy matching come from
[`@dbx-tools/model`](../../node/model).
