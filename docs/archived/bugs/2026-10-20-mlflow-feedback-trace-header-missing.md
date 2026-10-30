# MLflow feedback trace header is missing from chat responses

Status: Fixed

Archived: October 30, 2026

## Summary

AppKit-Mastra exports and promotes a chat trace while Databricks Apps removes
`x-mlflow-trace-id` from the browser response. UI-Mastra requires that trace ID
to associate feedback with an assistant message, so it hides the thumbs and
comment controls even though MLflow contains the trace, user, tags, and turn
metadata.

## Reproduction

- Application: `gismo-dev`
- `@dbx-tools/appkit-mastra`: `0.9.163`
- `@dbx-tools/ui-mastra`: `0.9.163`
- `@databricks/appkit`: `0.81.0`
- Feedback mode: `mlflow`
- Observability mode: `mlflow`
- Trace prefix: `dbxdemos_dev.metroplex.gismo`
- App principal permissions on `gismo_otel_annotations`: `SELECT`, `MODIFY`

A completed chat response contains:

```text
HTTP/2 200
content-type: text/event-stream
x-request-id: de362c10-a993-457e-b8f9-80e0bc410144
```

`x-mlflow-trace-id` is absent. The same turn is present in
`gismo_otel_annotations`, including request and response previews,
`mlflow.trace.user`, `mlflow.trace.session`, agent, and OBO tags.

## Cause

AppKit-Mastra sets `x-mlflow-trace-id` before streaming. The internal Express
tests confirm that contract, but the Databricks Apps ingress response does not
preserve the header. UI-Mastra therefore receives no trace ID and correctly
hides MLflow feedback.

Trace export and feedback correlation have different transport requirements:
the former completes through OTel and UC tables, while the latter needs the
browser to receive the trace ID during the chat response.

## Implemented remediation

The shared Mastra package defines a validated transient
`data-mlflow-trace` part. AppKit-Mastra writes that part before the first chat
stream chunk while retaining the response header for environments that preserve
it.

UI-Mastra reads the response header first and records the transient stream part
as a fallback. The transient part is not persisted in the assistant message.

Focused tests cover:

- response header preservation;
- server trace-part emission;
- client trace-part parsing;
- trace topology and metadata;
- stream completion and cancellation.

## Expected behavior

- Every MLflow-feedback turn exposes its trace ID through the header, stream
  part, or both.
- UI-Mastra stores the trace ID against the assistant message.
- `ChatView` renders thumbs and comment controls.
- Submitted feedback creates an assessment on the same MLflow trace.
- Genie feedback and deployments without MLflow remain unchanged.
