# `dbx-tools-model-proxy`

OpenAI-compatible LiteLLM proxy backed by Node-owned Databricks authentication,
model discovery, ranking, routing, and metadata.

LiteLLM owns request conversion, streaming, transport, and retry behavior. The
Python host only adapts calls through the generated `dbx-tools-models` client,
so authentication and model policy remain implemented once in Node.

## Run

```sh
uv run dbx-model-proxy --port 4000
```

The proxy listens on `127.0.0.1` unless a different host is forwarded to
LiteLLM. Select a Databricks profile explicitly when needed:

```sh
uv run dbx-model-proxy --profile my-workspace --port 4000
```

The host exposes LiteLLM's OpenAI-compatible APIs, a dynamic `GET /v1/models`
catalogue, and `GET /lookup` for Node-ranked fuzzy model search. Model requests
are resolved lazily and receive current Databricks authentication headers from
the generated client.

The standard model response keeps the OpenAI `data` array. Requests whose
`originator` header starts with `codex` also receive a Codex `models` array with
Node-ranked priorities, Databricks AI Gateway model names, reasoning levels,
and build-cached capability metadata. Embedding, retired, and unsupported Codex
families remain available through the OpenAI catalogue but are omitted from the
Codex extension.

## Service

Install and start the proxy as a per-user background service:

```sh
dbx-model-proxy service install -- --profile my-workspace --port 4000
```

The lifecycle includes `start`, `stop`, `restart`, `status`, and `uninstall`,
with `remove` as an uninstall alias. Configuration and logs default to
`~/.dbx-tools/model-proxy`. Uninstall retains them unless `--purge` is supplied.

Service installation uses the current package's exact Python environment and
registers a launchd agent on macOS, a systemd user unit on Linux, or current-user
scheduled tasks on Windows. `--systray auto` installs the tray when its native
backend is available. Use `always` to require it or `never` for a headless
service. The tray uses the dbx-tools icon, opens the local models and API pages,
switches among configured Databricks profiles, and can stop the service.

The proxy writes service output to `service.log` and tray output to `tray.log`.
Lifecycle operations fail inside Databricks Apps because host service management
is unavailable there.

For side-by-side A/B testing with the Rust proxy, add `--concurrent`:

```sh
dbx-model-proxy service install --concurrent -- --profile my-workspace
```

Concurrent mode defaults the Python proxy to port `4001` and uses the independent
`model-proxy-python` configuration directory, service registration, logs, and
tray identity. The Rust service can continue using its existing port `4000`
registration. An explicit `--port` after `--` overrides the concurrent default.

## Ownership

- `dbx-tools-models` owns authentication, profile selection, endpoint discovery,
  caching, fuzzy matching, protocol selection, URLs, and published metadata.
- LiteLLM owns Chat, Responses, embeddings, streaming, parameter conversion,
  provider transport, and retries.
- This package owns only FastAPI route installation, LiteLLM callback wiring,
  and command-line startup.

The initial implementation intentionally does not reproduce the Rust proxy's
process-local rate-limit queues, metrics, or protocol translation. Those
features should be added only where LiteLLM does not already provide equivalent
behavior.
