# `dbx-tools-databricks-client`

Generated Rust clients for Databricks workspace, account, and data-plane APIs.

## Key Features

- Covers every published modular Databricks API SDK package.
- Exposes one `progenitor` client module per API to prevent schema collisions.
- Builds from committed, validated OpenAPI 3.0.3 documents.
- Pins one modular SDK version for reproducible generation.
- Keeps generated API dependencies out of the lower-level
  `dbx-tools-databricks` authentication and runtime crate.

## Use

```rust
use dbx_tools_databricks_client::Client;

let client = Client::new("https://example.cloud.databricks.com");
let jobs = &client.jobs;
```

Use `Client::new_with_client` when requests need a preconfigured
`reqwest::Client` with Databricks authorization headers. Every service client
receives a clone of that handle, sharing its connection pool, TLS state, and
default headers.

## Generate

From the repository root:

```sh
bun run openapi
```

The Node generator reads the pinned modular JavaScript SDKs, writes validated
JSON under `assets/openapi`, and regenerates `src/lib.rs`. Both locations are
generated and must not be edited by hand.

## Modules

Each child module is named after its modular SDK package, with hyphens converted
to underscores. Examples include `jobs`, `modelserving`, `postgres`,
`statementexecution`, `uc_catalogs`, and `vectorsearch`.
