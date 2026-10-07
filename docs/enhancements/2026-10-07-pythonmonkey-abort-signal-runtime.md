# PythonMonkey AbortSignal Runtime Compatibility

## Objective

Make the generated PythonMonkey Node runtime safe for packages that use the
standard `AbortController` and `AbortSignal` web APIs, including Python
`dbx-tools-graphiti` execution in Databricks notebooks, Lakeflow Jobs, and
Databricks Apps.

## Observed failure

`dbx-tools-graphiti==0.9.50` bundles the Node model client into the generated
Python package. The bundle calls `AbortSignal.timeout(15000)` while loading
Databricks model metadata. Under PythonMonkey, the generated bootstrap installs
a minimal `AbortController` when one is absent but does not install the matching
global `AbortSignal` constructor. Graphiti initialization therefore fails with:

```text
ReferenceError: AbortSignal is not defined
```

The failure occurs before the Graphiti runtime can resolve its chat and
embedding models, so it blocks both the standalone Python API and the AppKit
sidecar even when PostgreSQL or Lakebase configuration is valid.

## Ownership

The fix belongs to the Python Node-bindings bootstrap generator, not to
Graphiti application code and not to the generated `_runtime.js` artifact.
The generator must provide one coherent standards-compatible web runtime before
loading any bundled dbx-tools module.

The model client should also avoid assuming `AbortSignal.timeout` exists unless
the owning runtime contract guarantees it. Generated bindings, PythonMonkey
bundles, and copied package artifacts remain derived output and must be
regenerated from their owner.

## Implementation plan

1. Extend the Python Node-bindings bootstrap to install matching
   `AbortSignal` and `AbortController` classes when either global is absent.
2. Implement `AbortSignal.timeout`, `AbortSignal.abort`, `aborted`, `reason`,
   `throwIfAborted`, and abort listener registration/removal.
3. Ensure every generated `AbortController.signal` is an `instanceof` the
   installed `AbortSignal`, because auth and HTTP code validate that contract.
4. Preserve native implementations when PythonMonkey or a future host provides
   both classes and patch only a missing static `timeout` method.
5. Regenerate Python bindings and verify no generated file requires a hand
   edit.
6. Add focused generator/runtime tests that load a bundled module using
   `AbortSignal.timeout`, exercise abort listeners, and pass the signal through
   code that performs `instanceof AbortSignal` validation.
7. Add a `dbx-tools-graphiti` Python test that constructs the runtime far enough
   to resolve model metadata without raising `ReferenceError`.
8. Validate the wheel in a plain Python process, a Spark notebook or notebook
   Job environment, and the AppKit Graphiti sidecar path.

## Downstream compatibility

The RaceTrac GISMO app temporarily carries a root `sitecustomize.py` shim and
the Graphiti synchronization notebook installs the same polyfill before
importing `GraphitiRuntime`. Remove both downstream shims after the corrected
dbx-tools release is adopted and validated in `RACETRAC-DEV`.

## Completion criteria

- PythonMonkey exposes compatible global `AbortSignal` and `AbortController`
  APIs before generated dbx-tools modules execute.
- `AbortSignal.timeout(...)` no longer raises during model metadata loading.
- Signals created by the controller pass `instanceof AbortSignal` checks.
- Generated binding synthesis is idempotent and contains no manual patch.
- Focused JavaScript and Python tests pass.
- `dbx-tools-graphiti` initializes successfully in a local Python process,
  Databricks notebook Job, and Databricks App sidecar.
- Downstream `sitecustomize.py` and notebook shims can be deleted.
