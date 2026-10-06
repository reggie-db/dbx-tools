# Promote Mastra chat turns as MLflow root traces with input and output

Status: In Progress

## Summary

Mastra chat spans reach a Databricks Apps Unity Catalog OTEL destination, but
they do not reliably become usable MLflow traces. Two framework behaviors are
involved:

1. AppKit 0.81 registers W3C propagation unconditionally and does not honor
   `OTEL_PROPAGATORS=none`.
2. appkit-mastra stamps `mlflow.spanInputs` and `mlflow.spanOutputs` on the
   active HTTP span, assuming that span is the exported trace root.

The first behavior can leave the exported chat trace with an ingress parent
that is not written to the app's OTEL table. MLflow requires an exported span
with `parent_span_id IS NULL`, so the entire chat turn is absent from the
experiment trace list.

Disabling propagation after AppKit starts makes the Mastra `invoke_agent` span
the exported root and causes the turn to appear in the experiment. That root
contains `mastra.agent_run.input` and `mastra.agent_run.output`, but not the
`mlflow.spanInputs` and `mlflow.spanOutputs` attributes read by the MLflow
unified view. The UI consequently shows blank Input and Output columns.

## Observed deployment

- Application: `gismo-dev`
- `@databricks/appkit`: `0.81.0`
- `@dbx-tools/appkit-mastra`: `0.9.5`
- Trace destination:
  `dbxdemos_dev.metroplex.gismo_otel_spans`
- Experiment:
  `/Shared/gismo-planner-runtime-observability`
- App environment: `OTEL_PROPAGATORS=none`

Before the application-level propagation workaround, the chat HTTP span had an
unexported parent:

```text
name: POST /api/mastra/agents/planner/stream
span_id: b583aa54fee01786
parent_span_id: a6844a79ef21c482
```

The trace contained hundreds of agent, model, memory, and processor spans but
no span with `parent_span_id IS NULL`. It was present in
`gismo_otel_spans` and absent from `gismo_trace_unified`.

After calling `propagation.disable()` in AppKit's `onPluginsReady` hook, the
chat turn appeared in `gismo_trace_unified`. Its root became:

```text
name: invoke_agent planner
parent_span_id: null
```

That root stores the correct values under Mastra attributes:

```text
mastra.agent_run.input:
[{"role":"user","parts":[{"type":"text","text":"Return exactly: root-visible-20261005"}]}]

mastra.agent_run.output:
{"text":"root-visible-20261005","files":[]}
```

The required MLflow attributes remain null:

```text
mlflow.spanInputs: null
mlflow.spanOutputs: null
```

The experiment UI therefore lists the 19-second chat trace but displays `-`
for both Input and Output.

## AppKit gap

`TelemetryManager._start()` constructs `NodeTracerProvider` and calls
`register()` without a propagator option. OpenTelemetry installs its default
W3C propagator, regardless of `OTEL_PROPAGATORS=none`. `TelemetryConfig` does
not expose a propagator field.

AppKit should do one of the following:

1. Honor the standard `OTEL_PROPAGATORS` environment variable when registering
   the provider.
2. Add a typed `propagator` option to `TelemetryConfig`.
3. Avoid replacing a propagator that the application configured before
   `createApp()`.

The supported `none` value must result in a no-op text-map propagator while
retaining the async context manager used to parent in-process child spans.

## appkit-mastra gap

`telemetry.ts` assumes the active HTTP span is the MLflow root. That assumption
must not determine whether request and response fields are visible.

The plugin should provide a deterministic root for each chat turn and put the
MLflow input/output attributes on that exact span. Viable designs include:

1. Start an explicit root chat span in the Mastra middleware using
   `ROOT_CONTEXT`, run the entire turn under it, and end it after the streamed
   response has been assembled.
2. Extend the Mastra OTEL bridge mapping so the root `invoke_agent` span copies
   `mastra.agent_run.input` and `mastra.agent_run.output` into
   `mlflow.spanInputs` and `mlflow.spanOutputs`.
3. Coordinate with AppKit so its HTTP server span is guaranteed to be the
   exported root and keep the existing middleware stamping behavior.

Do not create two independent root traces for one request. Agent, model, tool,
memory, and processor spans must remain children of the root carrying the
visible input and output.

## Local implementation

`appkit-mastra` now applies `OTEL_PROPAGATORS=none` during AppKit's
`setup:complete` lifecycle event. This runs after AppKit registers its tracer
provider and before the HTTP server starts. It disables only the global
propagator, leaving the async context manager active for in-process parent-child
relationships.

The chat I/O middleware now resolves AppKit's HTTP server span from OpenTelemetry
RPC metadata instead of assuming the active Express span is the exported root.
When no recording server or active span exists, it creates one request-lifetime
server span under the current context. With propagation disabled that span is
the sole local root. With W3C propagation enabled it remains a child of the
incoming remote parent.

The same selected root receives request messages and the final assistant text.
The output collector supports both Mastra SSE `text-delta` shapes, split UTF-8
chunks, and non-streaming `/generate` JSON responses.

For one text-only user message, the MLflow input preview is the raw prompt
instead of the serialized message envelope. The full request and response
remain on `appkit.mastra.chat.messages` and `appkit.mastra.chat.response`.
The root also records `appkit.mastra.identity.mode` (`obo` or
`service-principal`) and `appkit.mastra.genie.used`. These are searchable OTel
span attributes; custom OTel attributes do not become MLflow trace tags.

## Acceptance status

- [x] A local incoming-`traceparent` test with `OTEL_PROPAGATORS=none` exports
      exactly one span whose parent is null.
- [x] The local root span contains non-empty `mlflow.spanInputs` and
      `mlflow.spanOutputs`.
- [x] Text-only turns display raw prompt and answer text while retaining the
      full serialized request and response.
- [x] Local roots identify OBO versus service-principal execution and whether
      Genie emitted a tool or progress event.
- [ ] `*_trace_unified.request` and `*_trace_unified.response` contain the user
      message and final assistant answer in a deployed Databricks App.
- [ ] The experiment UI displays Input and Output for deployed streamed and
      non-streamed agent turns.
- [x] Local agent, model, tool, memory, and processor spans share the root trace
      ID.
- [x] Local downstream injection emits no `traceparent` when propagation is
      disabled.
- [x] Local W3C extraction, parentage, and injection continue to work when
      propagation is enabled.
- [x] Applications no longer need to call `propagation.disable()` themselves.
