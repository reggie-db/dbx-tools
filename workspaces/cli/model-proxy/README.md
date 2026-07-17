# @dbx-tools/model-proxy

Local OpenAI-compatible proxy for Databricks Model Serving.

Import this package or run its CLI when a tool expects the OpenAI API shape but
you want Databricks Model Serving auth, endpoint discovery, and fuzzy model
names. The proxy does not translate the OpenAI wire format; it resolves the
requested model, mints/refreshes Databricks auth through the SDK, and streams the
upstream response back to the caller.

Key features:

- OpenAI-compatible `/v1/*` forwarding for local tools that already know how to
  call chat/completions endpoints.
- Databricks SDK auth, including profile selection, token refresh, and workspace
  host resolution.
- Fuzzy model names and model-class requests powered by
  [`@dbx-tools/node-model`](../../node/model).
- Optional local API-key enforcement for loopback safety.
- One-shot terminal chat mode that injects `OPENAI_BASE_URL`, `OPENAI_API_KEY`,
  and `OPENAI_MODEL` into a child process.
- Programmatic Express app/server creation for tests and custom developer tools.

## Run The Proxy

```sh
model-proxy serve --profile my-workspace --port 4000
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
model-proxy chat --profile my-workspace --model "claude sonnet"
model-proxy chat --client "aichat" --model "chat fast"
```

`chat` starts the proxy, sets `OPENAI_BASE_URL`, `OPENAI_API_KEY`, and
`OPENAI_MODEL` for the child process, then shuts the proxy down when the child
exits. Use it to try Databricks-hosted models in any OpenAI-compatible terminal
client without editing that client's config.

## Inspect Model Resolution

```sh
model-proxy models --profile my-workspace
model-proxy resolve claude sonnet --profile my-workspace
```

These commands are useful when a client request resolves unexpectedly. They use
the same backend and resolver as the proxy server.

## Require A Client API Key

```sh
model-proxy serve --api-key "$LOCAL_PROXY_KEY"
```

With `--api-key` or `PROXY_API_KEY`, callers must send
`Authorization: Bearer <key>`. This protects the loopback proxy when another
local process may be able to reach it.

## Start Programmatically

```ts
import { backend, server } from "@dbx-tools/model-proxy";

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
   `body.model` through [`@dbx-tools/node-model`](../../node/model).
2. The Databricks SDK supplies a fresh authorization header for the workspace.
3. The proxy forwards the body to the resolved serving endpoint's
   `/invocations` route.
4. JSON or SSE response bodies are piped back unchanged.

This keeps the package small: Databricks already speaks the OpenAI schema, so
the useful work is auth and endpoint resolution.

## Modules

- `cli` - Commander program and `runCli()`.
- `backend` - `DatabricksBackend`, auth, model resolution, and upstream request
  forwarding.
- `server` - Express proxy app and `startProxyServer()`.
- `defaults` - bind host, port, and invocation path constants.

Endpoint ranking and fuzzy matching come from
[`@dbx-tools/node-model`](../../node/model).
