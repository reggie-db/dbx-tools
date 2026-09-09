# UniFFI Consolidation Plan

## Current Native Ownership

`dbx-tools-databricks` and `dbx-tools-google` generate Node and Python bindings
from their Rust APIs. Authentication, credential storage, token refresh,
Databricks App detection, and Google ADC therefore have one implementation.

The model and proxy crates are native Rust packages without a foreign-language
facade. Browser and framework integrations remain in their owning runtimes.

## Immediate Consolidation

### Lakebase address parsing

Export `ParsedAddress`, `SslMode`, `parse_address`, and
`parse_resource_path` from `dbx-tools-databricks`.

Python `dbx_tools.postgres.address` re-exports those generated values and keeps
only its string configuration type aliases. Node AppKit retains its native-free
parser because adding a native binding to the AppKit bootstrap package would
increase installation and deployment coupling.

Parity remains enforceable because the TypeScript test harness loads the
Rust-backed Python parser.

## Evaluated Candidates

### Rust model bindings for Node

A Node-only binding for `dbx-tools-model` could replace server-side parsing,
classification, and ranking in `@dbx-tools/model`. It should be considered only
when all of these conditions are met:

- The binding reuses the existing `packages/js/node/model` package instead of
  creating another public model package.
- Browser schemas remain in `@dbx-tools/shared-model`.
- AppKit request context and `CacheManager` stay in Node.
- Rust internal discovery records and browser wire records have distinct,
  explicit boundaries.
- The native dependency materially removes more Node code than its packaging
  and deployment cost adds.

This is not part of the immediate migration because the Node package still
needs AppKit-specific discovery and browser-safe wire contracts.

### Lakebase discovery

The Rust Lakebase proxy and Node AppKit resolver apply similar project, branch,
endpoint, and database selection rules. A future extraction can move the pure
selection policy into `dbx-tools-databricks` and test both clients against one
fixture set.

A full UniFFI resolver should wait until it can preserve:

- AppKit request-scoped authentication.
- Caller-provided WorkspaceClient behavior.
- Python credential-provider callbacks.
- Node and Python framework-specific connection configuration.

### Raw Databricks requests

`DatabricksClient` owns authenticated JSON and raw HTTP requests for Rust
consumers. Exporting a generic JSON request API through UniFFI is only useful
when a Node or Python package can remove an existing custom REST client. The
Databricks SDK and AppKit WorkspaceClient remain the preferred high-level
clients.

## Non-Candidates

Do not move these surfaces into UniFFI:

- `@dbx-tools/shared-core` or `@dbx-tools/shared-model`, because browsers cannot
  load native libraries.
- `dbx_tools.core`, because configuration and executable bootstrap helpers must
  remain dependency-light.
- SQLAlchemy engines, advisory locks, and the Postgres topic bus.
- AppKit plugin lifecycle, execution context, and WorkspaceClient adapters.
- Graphiti and Honcho process supervision.
- Rust proxy executables, because they already expose process and network
  protocols directly.

## Decision Gate

Add a new binding only when it removes a complete handwritten implementation,
keeps generated types as the only foreign-language contract, and does not force
a native dependency into browser or bootstrap packages. Otherwise preserve the
runtime-specific implementation and enforce parity with shared fixtures.
