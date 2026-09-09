# DRY And Code Quality Audit

## Scope

This audit covers the Rust Databricks, model, model proxy, and Lakebase proxy
crates together with their Node and Python consumers. A finding is actionable
when two implementations own the same policy or protocol behavior, or when a
public surface cannot be reviewed and maintained from its owning module.

## Sources Of Truth

- `dbx-tools-databricks` owns Databricks authentication, rejected-token retry,
  Lakebase address parsing, and the UniFFI contract.
- `dbx-tools-model` owns server-side model discovery, model-name parsing,
  capability policy, retirement status, ranking, and Databricks model identity.
- `@dbx-tools/shared-model` owns browser-safe schemas and request/response
  transformations that cannot depend on a native library.
- `@dbx-tools/core` and `dbx_tools.core` remain dependency-light runtime
  foundations. Product registries and product-specific policy do not belong
  there.
- `dbx-tools-postgres` owns SQLAlchemy, asyncpg, advisory-lock, and topic-bus
  behavior. Those framework-specific surfaces do not move into UniFFI.

## Confirmed DRY Findings

### Model proxy implementations

The supported local proxy is the Rust `dbx-model-proxy`. Graphiti uses its chat
and embedding routes. A second Python proxy would duplicate model routing,
Databricks authentication, response conversion, capability policy, and process
supervision.

### Authentication and rejected-token retry

Authenticated Databricks HTTP requests use `DatabricksClient`. Model discovery
and proxy routes call its raw or JSON request methods so authorization headers
and the single rejected-token retry are implemented once.

### Model policy

Responses-only routing, Codex eligibility, service-name conversion, reasoning
levels, tool support, retirement state, and model capabilities belong in
`dbx-tools-model`. Proxy routes and model listing consume those functions
instead of maintaining route-local family lists.

The browser package keeps a native-free classifier, but it recognizes complete
family tokens rather than matching variant words in arbitrary endpoint names.
Tests pin the shared classifications encoded in both runtimes.

### Generated model metadata

One Rust generator refreshes retirement and capability snapshots. The two
parsers share HTTP loading, text normalization, timestamp freshness, and atomic
write helpers. Runtime refresh uses the same parsers and falls back to the
committed snapshots.

### Lakebase addresses

Rust owns PostgreSQL URL, resource path, hostname, and project-id parsing.
Python consumes the generated Databricks binding directly. The Node AppKit
parser remains native-free because AppKit bootstrapping must not acquire a
native package dependency, and parity tests execute Node behavior against the
Rust-backed Python surface.

### Graphiti configuration

Graphiti uses `dbx_tools.core.config` for strings, booleans, and positive
integers. Its settings module owns model-proxy policy, not another set of
configuration coercers.

## Code Structure Findings

- The model proxy separates process startup, HTTP routing, protocol adaptation,
  and streaming state.
- Databricks profile code separates file loading, profile selection, and App
  authentication policy.
- Lakebase proxy code separates API discovery, session and credential state,
  PostgreSQL startup, cancellation, tunneling, and connection statistics.
- Public Rust APIs use resource-specific Databricks verbs such as
  `list_serving_endpoints`, `list_projects`, and
  `generate_database_credential`.

These boundaries keep tests focused on one protocol or policy and prevent large
entry-point modules from becoming the only place internal behavior can be
tested.

## Documentation Findings

Every public Rust library denies missing rustdoc and broken intra-doc links.
Public types, fields, variants, constructors, methods, constants, and errors
describe behavior and failure conditions. Package READMEs cover installation,
runtime behavior, modules, authentication, cache and fallback policy, and
generated assets.

## Intentional Runtime Boundaries

The following code remains language-specific:

- Browser schemas, React code, and Zod validation.
- AppKit workspace-client adapters and request-scoped OBO context.
- SQLAlchemy engines, Postgres drivers, and LISTEN/NOTIFY lifecycle.
- Graphiti, Neo4j, Caddy, and Honcho process integration.
- CLI argument parsing and terminal process forwarding.

Moving these surfaces into UniFFI would add native dependencies without
removing their framework-specific implementation.
