# Adopt Databricks Smart Router for automatic model selection

Status: complete

Archive date: 2026-10-29

## Outcome

Replace the model gateway's local automatic tier classifier with Databricks
Smart Router. Expose one virtual model named `smart_router` only when a
memoized live request confirms that `task_v3` is enabled and usable for the
active identity and candidate model menu.

The gateway option is tri-state: `auto` conditionally advertises the virtual
model, `true` makes model discovery fail when Smart Router is unavailable, and
`false` disables it.

The same service must support the standalone model gateway, embedded AppKit
routes, Mastra's unpinned model resolution, and one-shot CLI selection from a
text or JSON file.

## Verified upstream behavior

Databricks Unity Gateway and Omnigent call:

```http
POST /ai-gateway/routing/v1/routes:select
```

with a request shaped as:

```json
{
  "route_options": [{ "model": "system.ai.gpt-example", "harness": "codex" }],
  "task": { "prompt": "Refactor the parser" },
  "route_selector": { "router_name": "task_v3" }
}
```

The selected model is returned under
`route_selection[0].route_option.model`. `task_v3` profiling and policy
metadata is returned under `route_selection[0].params`. The caller must reject
a model that was not in the offered menu.

Supported coding-agent harness values are `codex` and `claude`. OpenAI
Responses and Chat Completions adopt the Codex policy. Anthropic Messages uses
the Claude policy. Smart Router is therefore a two-step selection flow for a
Responses request: extract task context, select a concrete route, then forward
the original request to that model.

## Design

### Shared contracts

`@dbx-tools/shared-model-gateway` owns the Zod request, response, observation,
and harness schemas plus the canonical `smart_router` id and response headers.
The previous automatic tier, reason-code, confidence, and System One contracts
are removed.

### Dedicated service

`@dbx-tools/appkit-model-gateway` exports `SmartRouterService` and
`SmartRouterContextBuilder`.

The context builder accepts plain strings, JSON strings, Responses input,
Chat/Anthropic messages, and generic objects. It prefers task-like fields,
retains bounded recent conversational context, and excludes credentials, tool
schemas, and tool arguments.

The service authenticates with the active AppKit or explicitly supplied
workspace client, calls `routes:select`, validates the response, and maps the
selected route back to the caller-owned candidate value.

### Capability probe

Model discovery performs a real `task_v3` selection against the live candidate
menu before returning `smart_router` from `/v1/models`. Probes are single-flight
and memoized by workspace client, router name, harness, and candidate menu.
The first lookup waits for the AppKit cache or a live probe. Later stale
in-process results return immediately while one refresh runs in the background.
When AppKit cache storage is initialized, the identity-scoped probe record is
also reused through its memory or configured persistent storage.
Successful probes use a five-minute TTL. Failed probes use a short negative TTL
so newly enabled workspaces recover without a process restart. Cached probes
are also revalidated by an unref'd hourly background refresh. A failed real
selection immediately replaces a cached positive result with a negative result,
so the next `/v1/models` response stops advertising `smart_router` without
waiting for the positive TTL or background interval.

### Gateway behavior

Only protocol-compatible, non-deprecated `system.ai.*` candidates are offered.
The selected model is pinned for the logical user turn through the existing
AppKit cache boundary. There is no local task classifier or deterministic
model fallback. A failed Smart Router request fails the virtual-model request
without affecting explicit model requests.

### Mastra behavior

Mastra stores the parsed request body in trusted `RequestContext`. Unpinned
HTTP turns use Smart Router when its probe succeeds, while explicit model or
model-class choices still win. The `/models` and `/default-model` routes expose
`smart_router` only after the same live probe. Non-HTTP callers can supply
`smartRouterInput`; callers without task content retain existing explicit/local
resolution.

### CLI behavior

`dbx model-gateway --select-model-from <path|->` reads JSON or text, calls the
same Smart Router service, prints the selected concrete endpoint plus route
metadata as JSON, and exits without starting the server.

## Validation checklist

- [x] Remove System One transport and automatic tier contracts.
- [x] Add Smart Router schemas, context extraction, transport, and memoized probe.
- [x] Advertise `smart_router` conditionally in OpenAI and Codex model lists.
- [x] Route Responses, Chat Completions, and Anthropic Messages transparently.
- [x] Add Mastra default-selection and model-list integration.
- [x] Add file/stdin CLI selection mode.
- [x] Regenerate derived package barrels, bindings, CLI docs, and site docs.
- [x] Run focused package tests, repository documentation checks, and live
      `task_v3` verification with an explicit Databricks profile.

## References

- [Select models or use Smart Routing](https://docs.databricks.com/aws/en/ai-gateway/coding-agent-model-selection)
- [Coding agent configuration schema](https://docs.databricks.com/aws/en/ai-gateway/coding-agent-config-schema)
- [Omnigent Smart Routing configuration](https://omnigent.ai/docs/reference/configuration/routing)
- [Databricks Unity Gateway](https://github.com/databricks/unity-gateway)
