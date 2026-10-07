# PythonMonkey AbortSignal Runtime Compatibility

Status: Complete

Archived: October 7, 2026

## Objective

Make generated PythonMonkey runtimes provide the web abort APIs required by
the bundled dbx-tools model and Graphiti code without downstream notebook or
application shims.

## Delivered

- Added compatible `AbortSignal` and `AbortController` implementations with
  abort reasons, listeners, `throwIfAborted`, static abort, and timeout.
- Preserved complete native implementations and patched only a missing native
  `AbortSignal.timeout` helper.
- Added standards-compatible `URL` and `URLSearchParams` globals from the
  bundled `whatwg-url` implementation.
- Added generator and runtime tests for abort behavior and `instanceof`
  compatibility.
- Moved all compatibility shims and the shared generated `runtime.js` into
  `dbx-tools-node-runtime`. Projen now generates only package-specific proxy
  bundles and thin Python adapters that import the runtime package.
- Restored PythonMonkey's supported `pythonmonkey.require` loader for generated
  Graphiti bindings after the `dbx-tools-node-runtime` bootstrap removed the
  serverless `pminit` blocker.

## Validation

- Focused Projen abort and Python binding tests pass with the standard loader.
- Focused Graphiti Python tests load the generated runtime and exercise the
  installed globals.
- A Databricks serverless Graphiti runtime initialized with standard
  PythonMonkey, connected to Lakebase, queued and persisted an episode, and a
  fresh runtime retrieved the same episode.
- AppKit Graphiti tests derive tool schemas and descriptions from OpenAPI and
  schedule the sidecar with the configured startup budget.

The direct native-extension evaluator explored for generated Graphiti bindings
was removed from that path. It was unnecessary once `pminit` could run with
packaged Node/npm launchers and had produced `SIGSEGV` failures during earlier
full Graphiti startup attempts.
