# dbx-tools-auth

Provider-neutral OAuth and persistent credentials for Rust, Node, and Python.
The crate owns authorization-code login with PKCE, client-credentials OAuth,
refresh-token rotation, rejected-token comparison, and check-lock-check
coordination. Databricks-specific profile and endpoint resolution stays in
[`dbx-tools-databricks-auth`](../databricks-auth).

`TokenProvider` is the Rust acquisition boundary. `ProviderOptions` exposes a
configurable OAuth provider through generated Node and Python bindings: provider
name, optional profile, scopes, endpoints, client identity, grant, storage, and
timeouts. No Google implementation is included; providers can be added without
copying the lifecycle or stores.

Credential identity is provider plus optional profile plus the SHA-256 hash of
trimmed, deduplicated, sorted scopes. Generic storage defaults to
`~/.dbx-tools/auth` and keyring service `dbx-tools-auth`; both can be overridden.
`FileLayout.Single` keeps one versioned `token-cache.json` and serializes refresh
for the entire file. `FileLayout.PerCredential` keeps one hashed credential
directory and token file per identity, with independent refresh locks. File
read-modify-write uses a separate short-held lock and atomic replacement.
Keyring storage coordinates by service and credential. Auto storage prefers the
OS keyring and falls back to files when the read probe cannot access it.

`StorageAdapter` supports custom persistence without any database dependency.
For cross-package use, create a `StorageHandle` in this package and pass the
handle to the provider wrapper. This preserves callback ownership when separate
native libraries are loaded. Access-token results never expose refresh tokens;
custom storage receives sensitive credential JSON and must protect it.

See the [Node](../../js/node/auth) and [Python](../../py/auth) packages.
