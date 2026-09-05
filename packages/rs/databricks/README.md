# dbx-tools-databricks

Shared Databricks runtime utilities for Rust, Node, and Python.

Key features:

- Databricks App detection from the platform name, host, and port environment;
- an explicit local/deployed runtime override;
- cached Databricks CLI availability detection;
- profile token acquisition for Databricks authentication providers;
- generated Node bindings merged into `@dbx-tools/databricks`.

## Databricks App detection

```rust
if dbx_tools_databricks::is_databricks_app() {
    // Select runtime behavior appropriate for a Databricks App.
}
```

`DBX_TOOLS_DATABRICKS_APP_ENV` takes precedence when it contains a recognized
boolean value. Otherwise detection requires a non-empty
`DATABRICKS_APP_NAME`, an HTTP(S) `DATABRICKS_HOST`, and a
`DATABRICKS_APP_PORT` from 1 through 65535.

## Databricks CLI access

`databricks_cli_available()` caches whether `databricks auth --help` succeeds
for the process. `databricks_cli_token()` runs
`databricks auth token --profile <name> --output json` and is used by
[`dbx-tools-databricks-auth`](../databricks-auth).

The Node package also contains workspace, filesystem, cloud, and network
utilities implemented directly in TypeScript. Projen combines those modules and
the generated bindings in one package.
