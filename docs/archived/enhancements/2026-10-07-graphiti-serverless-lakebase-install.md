# Graphiti Serverless Lakebase Installation

Status: Complete

Archived: October 7, 2026

## Objective

Install and run `dbx-tools-graphiti` on Databricks serverless notebook compute
when Graphiti uses Lakebase or another external PostgreSQL database, without
requiring embedded PostgreSQL or a system Node.js installation.

## Delivered

- Moved `embedded-postgres` out of the base package and into the `dev` extra.
- Lazy-loaded embedded PostgreSQL and added an actionable
  `dbx-tools-graphiti[dev]` error when local embedded mode is requested without
  the extra.
- Made Node, CLI, and AppKit runtimes request `[dev]` only when no external
  `databaseUrl` is configured.
- Added `dbx-tools-node-runtime`, which has no eager runtime dependencies. On
  first generated-binding use it reuses npm when available or installs a
  compatible `nodejs-wheel` into the active environment, creates direct shell
  launchers to the packaged Node binary and npm CLI, and installs standard
  PythonMonkey with those launchers available to `pminit` build isolation.
- Restored the supported `pythonmonkey.require` loader after proving standard
  PythonMonkey works with the staged Node/npm launchers.
- Kept `add_memory` queued and added `add_memory_sync`, queue status, queue
  drain, background error propagation, and shutdown drain/cancellation.
- Added `python -m dbx_tools.graphiti docs` and generated AppKit tools from the
  OpenAPI contract, including operation and parameter descriptions.
- Raised the default Graphiti startup budget to 180 seconds and limited strict
  parsing to Graphiti-owned AppKit fields.
- Corrected the OpenAPI `uuid` description: a supplied UUID selects an existing
  episode to update; callers omit it when creating a new episode.

## Installation

Managed environments without npm use the normal Graphiti installation:

```python
%pip install dbx-tools-graphiti
```

Graphiti resolves `dbx-tools-node-runtime` transitively. The first generated
binding load installs Node and PythonMonkey into the running Python environment
using a check-lock-check sequence. It preserves standard `pminit` and
PythonMonkey behavior and does not disable pip build isolation.

## Validation

An isolated local virtual environment installed the built
`dbx-tools-node-runtime` wheel, resolved `nodejs-wheel==22.20.0`, and used the
single module command to build and install standard `pminit==1.3.2` under pip
build isolation. The direct launchers reported Node `v22.20.0` and npm
`10.9.3`.

Databricks validation used the selected workspace profile, serverless job
`1041824640462209`, successful run `834023557620673`, and active Lakebase
endpoint `projects/lfp-chat-db/branches/production/endpoints/primary`.

A final clean serverless installation validation used one notebook command,
`%pip install dbx-tools-graphiti`, with the freshly built Graphiti wheel and a
local wheel directory for transitive resolution. Run `708789647294658` resolved
`dbx-tools-node-runtime` automatically, then the first generated binding call
installed `nodejs-wheel==22.20.0`, `pythonmonkey==1.3.2`, and `pminit==1.3.2`
into the notebook environment in 20.82 seconds. A second call completed in
0.0003 seconds. The packaged executables reported Node `v22.20.0` and npm
`10.9.3`; `/docs`, `/openapi.json`, all 11 direct tool operation IDs, and the
generated field descriptions were present.

The write notebook queued an episode, waited for the queue, immediately read
the generated episode UUID `13fdbfd0-2d21-44dc-8f24-477f05a0f459`, and logged
the complete grouped and unfiltered episode inventories. A separate notebook
runtime then read the same UUID and marker from Lakebase. Both tasks completed
successfully, proving persistence across serverless runtimes and clean runtime
shutdown after queue drain.

The earlier failed attempts supplied a new UUID to `Graphiti.add_episode`.
Graphiti 0.30.2 interprets that argument as an existing episode to update, so
the resulting `NodeNotFoundError` was expected API behavior rather than a
Lakebase persistence failure.
