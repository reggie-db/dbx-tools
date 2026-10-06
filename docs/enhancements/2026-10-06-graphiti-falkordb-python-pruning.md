# Graphiti FalkorDB And Python Pruning

## Objective

Replace Graphiti's managed Neo4j and PostgreSQL journal stack with the existing
Node-owned durable FalkorDB runtime, remove dead Python packages and examples,
and keep the remaining Python surface limited to the pinned upstream Graphiti
MCP adapter.

## Assumptions

1. Tag `v0.9.41` is the completed first release checkpoint requested in the
   originating Cursor chat.
2. "Replace with FalkorDB" means `@dbx-tools/falkor-db` owns the active graph,
   local RDB lifecycle, and shutdown behavior. Graphiti must not start Redis,
   FalkorDB, Neo4j, or a separate durability implementation itself.
3. The upstream Graphiti `0.29.3` MCP application remains Python and is bundled
   inside the Graphiti adapter wheel. Java, Neo4j, mise, uv project
   environments, Honcho, Caddy, and Postgres journaling are removed.
4. Node supervises FalkorDB, the optional model gateway, and the Python MCP
   process. The Python package continues to use generated PythonMonkey bindings
   for shared option validation and Databricks model resolution.
5. Graphiti-specific `up`, `down`, `status`, and `env` commands duplicate the
   shared desktop-service lifecycle and are removed rather than retained as
   compatibility shims. Foreground execution and `service` remain.
6. `dbx-tools-postgres`, `dbx-tools-core`, and their Python examples are dead
   after Graphiti journal and source-bootstrap removal.
7. The standalone `scripts/install.mjs` remains because `scripts/install.sh`
   invokes it; only its mise-specific reshim and obsolete TypeScript/QuickJS
   installer test surfaces are removed.
8. The bundled upstream source is copied from Graphiti tag `v0.29.3`, directory
   `mcp_server/src`, and verified against committed SHA-256 hashes. Runtime
   network downloads are not permitted.
9. The second release is attempted only after focused and workspace validation;
   unrelated failures are reported rather than repaired.

## Completion Criteria

- Graphiti uses a private FalkorDB Unix socket supplied by
  `@dbx-tools/falkor-db`.
- No active source, dependency, CLI help, or product documentation references
  Neo4j, Graphiti Postgres journals, Caddy, Honcho, or the removed Python
  Postgres package.
- The Python core and Postgres distributions are removed rather than retained
  as compatibility shims.
- The Graphiti wheel contains the pinned MCP source and its provenance manifest.
- Projen synthesis is idempotent, relevant tests and compilation pass, and the
  release workflow completes from `main`.
