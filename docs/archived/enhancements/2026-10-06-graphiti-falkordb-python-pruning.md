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
4. `@dbx-tools/graphiti` supervises FalkorDB and the Python MCP process, resolves
   both Databricks model routes, and owns authentication refresh. Graphiti does
   not start or depend on the model gateway. CLI and AppKit packages consume
   this Node owner rather than interacting with Python directly.
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
9. This follow-on does not request a commit or release. Changes remain local
   after focused and workspace validation; unrelated failures are reported
   rather than repaired.
10. "Remove all CLI and deps from Python Graphiti" means removing the Python
    CLI/config layer, generated PythonMonkey bindings, and their direct
    `pythonmonkey`, `httpx`, and `openai` pins. The wheel retains only the
    dependencies imported by the bundled upstream MCP application or required
    for Graphiti/FalkorDB itself.
11. Graphiti `0.29.3` accepts caller-supplied `AsyncOpenAI` clients. The adapter
    uses that constructor seam to rewrite SDK-generated request URLs to the
    exact Node-resolved Databricks chat and embedding routes without modifying
    the pinned upstream source.
12. Long-lived OAuth headers cannot be serialized once at process startup.
    Node therefore exposes a random-token-protected loopback header broker that
    returns a freshly authenticated route for each SDK request. Model payloads
    continue directly from Python to Databricks; the broker never proxies model
    request or response bodies.
13. Graphiti no longer supports an externally supplied OpenAI-compatible
    gateway URL. Model choice remains configurable, while endpoint URL and
    authentication are always resolved by `@dbx-tools/model` in Node.
14. The requested `node/grophiti` path is treated as a spelling variant of the
    established Graphiti product name, so the Node owner is
    `packages/js/node/graphiti` and publishes as `@dbx-tools/graphiti`.

## Completion Criteria

- Graphiti uses a private FalkorDB Unix socket supplied by
  `@dbx-tools/falkor-db`.
- No active source, dependency, CLI help, or product documentation references
  Neo4j, Graphiti Postgres journals, Caddy, Honcho, or the removed Python
  Postgres package.
- The Python core and Postgres distributions are removed rather than retained
  as compatibility shims.
- The Graphiti wheel contains the pinned MCP source and its provenance manifest.
- The Python wheel contains no generated Node bundle, PythonMonkey runtime, or
  Python-owned option/model resolver.
- Chat, reranker, and embedding SDK calls use direct Databricks routes with
  per-request headers minted by the Node owner.
- `@dbx-tools/graphiti` exposes start, stop, and foreground run;
  `@dbx-tools/cli-graphiti` contains only command and service composition, while
  `@dbx-tools/cli-service` installs the matching wheel into a service-owned uv
  environment.
- Projen synthesis is idempotent and relevant tests, compilation, lint, docs,
  Python build, and version checks pass.
