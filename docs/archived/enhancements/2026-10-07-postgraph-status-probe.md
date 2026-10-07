# PostGraph Status Probe

Status: Implemented and archived October 7, 2026. The direct tool now uses the
active driver's native health probe, focused tests pass, and Lakebase returned
`status=ok`. Deployed-app repetition was explicitly deferred.

## Objective

Make the direct Graphiti `get_status` tool report the health of the active
database driver instead of issuing a Neo4j-only Cypher probe against PostGraph.

## Observed failure

The unified `dbx-tools-graphiti` runtime starts successfully on Lakebase and
serves `/healthcheck`, search, and direct tools. However, the synchronized
upstream MCP `get_status` implementation always executes:

```text
MATCH (n) RETURN count(n) as count
```

PostGraph passes session queries to PostgreSQL, so the status tool returns:

```text
Graphiti MCP server is running but database connection failed:
syntax error at or near "MATCH"
```

This is a false negative after the runtime has already connected and completed
PostGraph index initialization.

## Ownership

The composed `dbx_tools.graphiti.main` application owns the direct REST tool
surface. It should provide a runtime-aware status function rather than patching
the synchronized upstream MCP source or teaching the application to ignore the
error.

## Implementation plan

1. Add a wrapper-owned status function that checks the initialized runtime.
2. Use a native `SELECT 1` probe when the active driver exposes a PostGraph
   client.
3. Preserve the upstream session probe for non-PostGraph drivers.
4. Register the wrapper-owned function only for `/tools/get_status`; leave the
   synchronized MCP server untouched.
5. Add tests for ready, not-ready, PostGraph, and generic-driver behavior.

## Completion criteria

- `/tools/get_status` returns `status=ok` for a healthy Lakebase/PostGraph
  runtime.
- The probe executes valid PostgreSQL rather than raw Cypher on PostGraph.
- A missing or unready runtime returns a clear error response.
- Other direct Graphiti tools and the mounted upstream MCP server are unchanged.
- Focused Python tests pass.

## Progress

- [x] Added a wrapper-owned runtime status function.
- [x] Added the PostGraph-native `SELECT 1` probe and generic-driver fallback.
- [x] Registered the wrapper only for the direct `/tools/get_status` route.
- [x] Added ready and not-ready tests; all focused Graphiti Python tests pass.
- [x] Validated against RaceTrac Dev Lakebase with `status=ok` and provider
  `postgraph`.
- [x] Closed deployed-app repetition without execution at the user's request;
  direct RaceTrac Dev Lakebase validation is the retained acceptance evidence.
