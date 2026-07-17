# @dbx-tools/model-proxy

A local, OpenAI-compatible proxy in front of Databricks Model Serving. Point any
tool that speaks the OpenAI API (an editor, the `openai` SDK, `curl`) at a
loopback URL, type a loose model name like `claude sonnet`, and the request is
fuzzy-resolved to a real serving endpoint, authenticated with a fresh workspace
token, and forwarded to Databricks.

```bash
# Start the proxy (defaults to 127.0.0.1:4000); auth via your Databricks SDK
# config / profile / OAuth login.
model-proxy serve --profile my-workspace

# In another shell, talk to it with the OpenAI wire format:
curl http://127.0.0.1:4000/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model": "claude sonnet", "messages": [{"role": "user", "content": "hi"}]}'
```

Configure an OpenAI client with `base_url = http://127.0.0.1:4000/v1` and any
API key (none is required unless you set `--api-key`). The response carries an
`x-resolved-model` header showing which endpoint a loose name snapped to.

## Commands

```
model-proxy serve      Run the loopback OpenAI-compatible proxy (default).
model-proxy chat       Start the proxy and launch a terminal chat client wired to it.
model-proxy models     List resolvable serving endpoints (JSON).
model-proxy resolve    Show what a fuzzy model name resolves to (JSON).
```

Fuzzy resolution + the cached catalogue come from
[`@dbx-tools/node-model`](../../node/model).
