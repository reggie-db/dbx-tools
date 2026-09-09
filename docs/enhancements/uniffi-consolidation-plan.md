# UniFFI Package Boundaries

Status: implemented.

## Package Rule

Every UniFFI crate generates dedicated Node and Python packages. A Rust crate
folder `<name>` maps to:

- Node folder `packages/js/node/<name>-rs` and package
  `@dbx-tools/<name>-rs`;
- Python folder `packages/py/<name>-rs`, distribution
  `dbx-tools-<name>-rs`, and module `dbx_tools.<name>_rs`.

Generated bindings are never merged into handwritten packages. Python package
initializers remain empty, so generated values are imported from
`dbx_tools.<name>_rs.bindings`.

## Native Ownership

- `dbx-tools-core` owns authentication, credential storage, token refresh,
  Databricks App detection, flexible middleware-backed API requests, Lakebase
  address parsing, file locking, caching, and logging. Its bindings are
  `@dbx-tools/core-rs` and `dbx-tools-core-rs`.
- `dbx-tools-lakebase-proxy` owns Lakebase resource discovery and database
  credentials through the core client. It has no UniFFI surface.
- `dbx-tools-google` shares core's token lifecycle. Its bindings are
  `@dbx-tools/google-rs` and `dbx-tools-google-rs`.

## Native-only Surfaces

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
