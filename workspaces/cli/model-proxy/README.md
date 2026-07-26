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
  API (the Codex CLI, for one), translated to and from Chat Completions -
  streaming included - by
  [`@dbx-tools/shared-model`](../../shared/model)'s `openaiResponses`.
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
4. The proxy forwards the body to the resolved serving endpoint's
   `/invocations` route.
5. JSON or SSE response bodies are piped back unchanged.

This keeps the package small: Databricks already speaks the OpenAI schema, so
the useful work is auth and endpoint resolution.

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
the `proxy` log line. `/v1/responses` is unaffected: it builds the chat body
field-by-field and never copies these through.

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
- `defaults` - bind host, port, and invocation path constants.

Endpoint ranking and fuzzy matching come from
[`@dbx-tools/model`](../../node/model).
