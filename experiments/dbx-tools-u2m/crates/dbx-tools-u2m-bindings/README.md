# dbx-tools-u2m UniFFI component

Single foreign-language facade for `dbx-tools-u2m`. UniFFI annotations in `src/lib.rs` generate the Node.js TypeScript and Python APIs, so a newly exported method is available to both generators without maintaining two handwritten Rust wrappers.

The public method names mirror `databricks-sdk-go/credentials/u2m.PersistentAuth`:

- Rust `challenge` becomes Node `challenge()` and Python `challenge()`.
- Rust `token` becomes Node `token()` and Python `token()`.
- Rust `force_refresh_token` becomes Node `forceRefreshToken()` and Python `force_refresh_token()`.
