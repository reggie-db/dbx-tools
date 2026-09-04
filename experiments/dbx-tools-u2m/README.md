# dbx-tools-u2m experiment

Experimental Rust workspace for Databricks user-to-machine OAuth. It follows the Databricks Go SDK's `credentials/u2m` behavior while adding secure-by-default persistence and per-profile cross-process refresh coordination.

This workspace is not part of the generated `dbx-tools` package workspace and is not published.

## Workspace crates

| Crate | Purpose |
| --- | --- |
| `dbx-tools-u2m` | OAuth, Databricks profile resolution, token refresh, memory/file/keyring stores, and the generic storage traits |
| `dbx-tools-u2m-postgres` | Optional Postgres `CredentialStore` implementation with advisory locking |
| `dbx-tools-u2m-cli` | Standalone `dbx-tools-u2m` executable |

Rust does not have Python-style `package[extra]` syntax. The closest equivalents are optional Cargo features and separate adapter crates. Consumers that need Postgres add both libraries:

```toml
[dependencies]
dbx-tools-u2m = { path = "crates/dbx-tools-u2m" }
dbx-tools-u2m-postgres = { path = "crates/dbx-tools-u2m-postgres" }
```

The CLI exposes Postgres as an optional feature:

```bash
cargo install --path crates/dbx-tools-u2m-cli --features postgres
```

Without that feature, the CLI and its dependency graph contain no SQLx or Postgres runtime.

## Key features

- OAuth 2.0 authorization-code flow with PKCE through the maintained `oauth2` crate.
- Databricks workspace, account, and unified-host endpoint handling.
- Browser callback ports `8020` through `8040`, matching the Go SDK fallback range.
- Default `databricks-cli` public client and `all-apis offline_access` scopes.
- Databricks profiles are treated as browser OAuth configuration; no Databricks CLI subprocess is used.
- Access and rotated refresh tokens are persisted after every successful login or refresh.
- OS keyring storage by default when available, using the Databricks CLI service and per-profile account names.
- Memory, file, keyring, and optional Postgres storage through one `CredentialStore` trait.
- Check-lock-check refresh flow under a per-profile lock.

## Storage and locking

| Backend | Owning crate | Credential persistence | Per-profile locking |
| --- | --- | --- | --- |
| `keyring` | `dbx-tools-u2m` | OS-native secure storage under service `databricks-cli` | Per-profile OS file lock under `~/.databricks/locks` |
| `file` | `dbx-tools-u2m` | Go CLI-compatible `~/.databricks/token-cache.json` written by atomic replacement | Shared cache-file lock plus per-profile OS refresh lock |
| `memory` | `dbx-tools-u2m` | Process memory | OS file lock in the application cache directory |
| `postgres` | `dbx-tools-u2m-postgres` | JSONB row per profile | PostgreSQL advisory lock held by a dedicated pooled connection |

File and keyring locking uses `fs4`, which delegates to operating-system file locking. Acquisition uses bounded polling so it works consistently on platforms where a blocking lock cannot be canceled. Postgres uses `pg_try_advisory_lock` with the same bounded polling policy. Locks are keyed by profile, so unrelated profiles do not block each other.

The keyring uses the same service name, profile account key, and `{ "token": ... }` envelope as the Go CLI. Plaintext mode uses the Go CLI's version-1 `~/.databricks/token-cache.json` envelope and OAuth field names, so either CLI can read credentials written by the other. Additional lock files do not alter that token format.

## CLI

Run the default CLI with keyring support:

```bash
cargo run --manifest-path experiments/dbx-tools-u2m/Cargo.toml \
  --package dbx-tools-u2m-cli -- \
  --profile FEVM-REGGIE-PIERCE-AWS login

cargo run --manifest-path experiments/dbx-tools-u2m/Cargo.toml \
  --package dbx-tools-u2m-cli -- \
  --profile FEVM-REGGIE-PIERCE-AWS token
```

Run it with the optional Postgres adapter:

```bash
DBX_TOOLS_U2M_POSTGRES_URL=postgresql://localhost/example \
  cargo run --manifest-path experiments/dbx-tools-u2m/Cargo.toml \
  --package dbx-tools-u2m-cli --features postgres -- \
  --storage postgres --profile FEVM-REGGIE-PIERCE-AWS token
```

The CLI emits access-token JSON but never emits a refresh token. Avoid copying token output into logs.

Arguments have environment equivalents:

| Argument | Environment variable |
| --- | --- |
| `--profile` | `DATABRICKS_CONFIG_PROFILE` |
| `--host` | `DATABRICKS_HOST` |
| `--account-id` | `DATABRICKS_ACCOUNT_ID` |
| `--workspace-id` | `DATABRICKS_WORKSPACE_ID` |
| `--config-file` | `DATABRICKS_CONFIG_FILE` |
| `--client-id` | `DATABRICKS_CLIENT_ID` |
| `--scopes` | CLI argument, matching `databricks auth login --scopes` |
| `--storage` | `DBX_TOOLS_U2M_STORAGE` |
| `--cache-dir` | `DBX_TOOLS_U2M_CACHE_DIR` |
| `--postgres-url` | `DBX_TOOLS_U2M_POSTGRES_URL`, when compiled with `postgres` |

Configuration precedence is explicit CLI argument, Databricks environment variable, selected section in `~/.databrickscfg`, then defaults. `DATABRICKS_CONFIG_FILE` supports the Go SDK's `~` expansion. Profile selection is explicit `--profile`, `DATABRICKS_CONFIG_PROFILE`, `[__settings__].default_profile`, then the legacy `DEFAULT` fallback. It intentionally does not select the sole profile automatically, matching the SDK auth rule rather than the CLI's prompt-seeding convenience. Existing `auth_type = databricks-cli` and `auth_type = external-browser` profiles both resolve to this library's browser OAuth flow.

Storage selection accepts the Go CLI's `DATABRICKS_AUTH_STORAGE=secure|plaintext` and `[__settings__].auth_storage` settings. The experiment's `--storage` and `DBX_TOOLS_U2M_STORAGE` remain higher-priority extensions for memory and Postgres backends.

## Core library

```rust
use dbx_tools_u2m::{AuthClient, AuthOptions, Profile, ProfileOptions, StoreOptions, open_store};

let profile = Profile::from_sources(ProfileOptions::default())?;
let store = open_store(StoreOptions::default()).await?;
let client = AuthClient::new(profile, store, AuthOptions::default())?;
let token = client.token_or_login().await?;
```

`token()` never opens a browser. `token_or_login()` opens one only when no cached refresh-capable credential exists. `login()` always performs a new browser authorization.

## Postgres adapter

```rust
use std::sync::Arc;
use dbx_tools_u2m::{AuthClient, AuthOptions, Profile, ProfileOptions};
use dbx_tools_u2m_postgres::PostgresStore;

let profile = Profile::from_sources(ProfileOptions::default())?;
let store = Arc::new(PostgresStore::connect("postgresql://localhost/example").await?);
let client = AuthClient::new(profile, store, AuthOptions::default())?;
```

The database role must be able to create and modify `dbx_tools_u2m_tokens` in its current schema and use advisory locks. The Postgres URL is intentionally separate from Databricks profile resolution because this experiment does not assume a particular Lakebase credential source.
