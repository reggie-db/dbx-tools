# dbx-tools-auth

Provider-neutral OAuth and persistent credentials for Rust, Node, and Python.
The crate owns authorization-code login with PKCE, client-credentials OAuth,
refresh-token rotation, rejected-token comparison, and check-lock-check
coordination. Databricks-specific profile and endpoint resolution stays in
[`dbx-tools-databricks-auth`](../databricks-auth).

`TokenProvider` is the Rust acquisition boundary. `ProviderOptions` exposes a
configurable OAuth provider through generated Node and Python bindings: provider
name, optional profile, scopes, endpoints, client identity, grant, storage, and
timeouts. `dbx-tools-google-auth` imports this lifecycle and its generated
contracts directly.

## Shared options and provider implementations

Rust and UniFFI records do not support class inheritance. `ProviderOptions.auth`
and `DatabricksAuthOptions.auth` compose the same Rust-owned `AuthOptions` record;
the generated Node and Python providers import that record from shared auth.
Omit `auth` to use the defaults: a 30-second lock timeout, a 3600-second login
timeout, a 300-second refresh window, and the built-in callback image.
Explicit records use `AuthOptions::default()` in Rust, `AuthOptions.create({})`
in Node, and `AuthOptions()` in Python. Node represents the integer seconds as
`bigint`; Python uses `int`. Negative refresh windows are supported, but an
expired token is never reused simply because its refresh window is negative.

```rust
use dbx_tools_auth::AuthOptions;

let auth = AuthOptions {
    lock_timeout_seconds: 10,
    ..AuthOptions::default()
};
```

Rust provider wrappers implement `AuthSession::auth_client` to inherit login,
token lookup, login-policy dispatch, forced refresh, rejected-token comparison,
logout, and backend naming. Import `AuthSession` to call these trait methods.
`TokenProvider` deliberately requires acquisition and refresh implementations:
a default refresh that opens a browser would violate noninteractive token
lookup. Its safe default is `can_authenticate_silently() == false`.

`CredentialStore::prepare_write` defaults to a no-op, while
`StorageLock::release` consumes and drops an RAII lease. Lock acquisition and
credential mutation remain required. UniFFI foreign callback interfaces do not
inherit Rust default bodies: Node/Python `StorageAdapter` implementers must
provide every method, including an explicit no-op preflight when appropriate.

Credential identity is provider plus optional profile plus the SHA-256 hash of
trimmed, deduplicated, sorted scopes. Generic storage defaults to
`~/.dbx-tools/auth`; the directory can be overridden.
`FileLayout.Single` keeps one versioned `token-cache.json` and serializes refresh
for the entire file. `FileLayout.PerCredential` keeps one hashed credential
directory and token file per identity, with independent refresh locks. File
read-modify-write uses a separate short-held lock and atomic replacement.
Memory storage retains access tokens only for the current process while using
an in-process lock for refresh coordination.

`StorageAdapter` supports custom persistence without any database dependency.
For cross-package use, create a `StorageHandle` in this package and pass the
handle to the provider wrapper. This preserves callback ownership when separate
native libraries are loaded. Access-token results never expose refresh tokens;
custom storage receives sensitive credential JSON and must protect it.
Both `create_provider_auth_with_storage` and
`create_persistent_auth_with_storage` accept that same handle. Wrap an adapter
with `create_storage_handle` (Node: `createStorageHandle`) before passing it to
either factory.

See the [Node](../../js/node/auth) and [Python](../../py/auth) packages.
