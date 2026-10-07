# Active enhancements

Keep plans here while code or documentation changes are still active. Move a
plan to `docs/archived/enhancements` once its tracked work is complete or
explicitly abandoned.

Prefix new audits and plans with their creation date in `YYYY-MM-DD-` form so
repeated reviews remain distinct. Update the active document as findings are
completed or reprioritized. When all tracked work is complete or intentionally
closed, move the document to `docs/archived/enhancements` and record its archive
date and final status.

## Active plans

- [Promote Mastra chat turns as MLflow root traces with input and output](2026-10-05-mlflow-root-chat-input-output.md)
- [PythonMonkey AbortSignal runtime compatibility](2026-10-07-pythonmonkey-abort-signal-runtime.md)
  owns the generated-runtime fix required for Graphiti in Python, Spark
  notebooks, Lakeflow Jobs, and Databricks Apps.

## Cross-repository suggestions

When work in another repository identifies a change for this project, copy a
self-contained plan into this repository rather than leaving the suggestion
only in the source project. Track and update the work here, where the code
lives. When its tracked work is complete or explicitly abandoned, move it to
`docs/archived/enhancements`.

Use the same lifecycle for defects: copy them into `docs/bugs`, handle them in
this repository, and move them to `docs/archived/bugs` when resolved or no
longer active.
