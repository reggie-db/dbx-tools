# Graphiti Sidecar Startup Budget

Status: Implemented and archived October 7, 2026. The package-owned startup
budget, tolerant AppKit base-config parsing, generated bindings, and focused
tests are complete. Deployed-app acceptance was explicitly deferred and does
not require a parallel application shim.

## Objective

Make AppKit Graphiti startup reliable when PostgreSQL/PostGraph initialization
legitimately takes longer than the plugin's current fixed 60-second readiness
deadline, including Lakebase-backed Databricks Apps.

## Observed failure

`@dbx-tools/appkit-graphiti@0.9.51` launches the Python Graphiti runtime and
polls `/healthcheck` for a hard-coded 60 seconds. A RaceTrac Dev Lakebase
startup completed successfully immediately after that deadline, causing the
plugin to terminate an otherwise healthy app.

Focused timing against `RACETRAC-DEV` showed:

- model routing and client creation: 1.3 seconds;
- Lakebase connection: 4.0 seconds;
- idempotent PostGraph index and constraint setup: 55.1 seconds;
- total Graphiti runtime startup: 60.4 seconds.

The failure is therefore a readiness-budget race, not an authentication,
model-discovery, PythonMonkey, or database-connectivity failure.

## Ownership

The AppKit Graphiti plugin owns sidecar supervision and readiness policy. An
application should not subclass the plugin, patch generated output, or carry a
local timeout shim. The shared Graphiti option contract should expose the
startup budget and serialize it consistently into Node, AppKit, CLI, and
generated Python option bindings.

## Implementation plan

1. Add a positive `startupTimeoutMs` Graphiti option with a
   `DBX_TOOLS_GRAPHITI_STARTUP_TIMEOUT_MS` environment binding.
2. Default the budget above known Lakebase/PostGraph cold-start time while
   preserving bounded startup failure.
3. Make the AppKit plugin readiness loop use the resolved option instead of a
   package constant.
4. Keep the healthcheck request timeout and retry interval separate from the
   total startup budget.
5. Regenerate shared option bindings, manifests, API documentation, and package
   artifacts from their owners.
6. Add focused option and plugin tests for the default, explicit override, and
   timeout behavior.
7. Validate a Lakebase-backed sidecar that becomes ready after 60 seconds and
   confirm shutdown still terminates the Python supervisor.
8. Parse only Graphiti-owned option fields so AppKit base fields remain valid
   under the plugin's strict shared option schema.

## Completion criteria

- AppKit Graphiti does not terminate a healthy Lakebase-backed runtime that
  needs more than 60 seconds for index setup.
- Operators can tune the bounded startup budget without subclassing or patching
  the plugin.
- The environment variable uses the required `DBX_TOOLS_` prefix.
- Invalid, zero, and negative timeout values fail schema validation.
- Existing Graphiti option serialization and generated Python bindings remain
  synchronized and idempotent.
- Focused JavaScript and Python tests pass.
- RaceTrac GISMO starts without a local readiness shim and can expose Graphiti
  tools from a deployed Databricks App.

## Progress

- [x] Added `startupTimeoutMs` with a 180-second default and
  `DBX_TOOLS_GRAPHITI_STARTUP_TIMEOUT_MS` environment binding.
- [x] Updated AppKit readiness supervision to use the resolved budget.
- [x] Regenerated Python Node bindings twice with an idempotent second run.
- [x] Added default, environment, invalid-value, and plugin-budget tests.
- [x] Preserved AppKit base fields while strictly validating Graphiti-owned
  option overrides.
- [x] Passed focused JavaScript builds, Python tests, documentation checks, and
  workspace version checks.
- [x] Validated RaceTrac Dev locally: the sidecar became ready after the former
  60-second cutoff and the application remained healthy.
- [x] Closed deployed-app validation without execution at the user's request;
  the local Lakebase timing and focused supervision tests are the retained
  acceptance evidence.
