# dbx-tools-core

Databricks authentication, flexible API requests, Lakebase parsing, caching,
and filesystem primitives.

Key features:

- Databricks App detection and CLI token access.
- U2M browser OAuth, M2M client credentials, and PAT authentication.
- Profile, account, workspace, scope, and endpoint resolution.
- Shared token lifecycle with file, memory, or caller-provided storage.
- A `reqwest-middleware` client that defaults to the resolved credential host,
  omits credentials for other origins, and retries one rejected token.
- Flexible JSON requests with an optional body and method.
- Lakebase address parsing for PostgreSQL URLs, resource paths, hosts, and
  project ids.
- Cross-process file locking and file-backed TTL caches.
- Shared tracing initialization from `LOG_LEVEL`, defaulting to `info`.
- UniFFI bindings published separately as `@dbx-tools/core-rs` and
  `dbx-tools-core-rs`.

Databricks-specific authentication lives under `src/auth`. Reusable OAuth flows
and templates live under `src/oauth`. Credential records, token lifecycle, and
storage live under `src/credentials`. File cache and lock primitives remain at
the crate root.

Outside Databricks Apps, automatic U2M uses
`databricks auth token --profile` when the CLI is available and falls back to
the native browser flow otherwise. Missing or invalid credentials invoke login
after acquisition or refresh fails unless the caller passes `login = false`.
The same default applies to force-refresh and rejected-token refresh. Inside an
CLI-backed U2M profile, login runs through `databricks auth login --profile`;
native OAuth uses its browser flow. Inside an App, automatic storage uses
memory and does not invoke the CLI. M2M always uses the native
client-credentials flow.

Inside an App, `create_persistent_auth` reads request headers from
`DatabricksAuthOptions`. It prefers `app_obo` when the configured access-token
header is present, then falls back to `app_sp` from `DATABRICKS_HOST`,
`DATABRICKS_CLIENT_ID`, and `DATABRICKS_CLIENT_SECRET`. The header defaults to
`authorization` and accepts the `Bearer` scheme. Set `access_token_header` for
another trusted front-door header. OBO tokens are returned directly without
caching because the front door refreshes them per request. Set `auth_type` or
`profile` explicitly to override automatic App resolution.

```rust
use dbx_tools_core::DatabricksClient;

let client = DatabricksClient::new(None).await?;
let endpoints = client
    .request("/api/2.0/serving-endpoints", None, None)
    .await?;
```

## Modules

- `auth` resolves Databricks profiles and App authentication policy.
- `oauth` contains provider-neutral authorization-code and client-credential
  flows.
- `credentials` owns token lifecycle and file, memory, or foreign storage.
- `client` wraps `reqwest-middleware` with host-scoped authentication.
- `lakebase_address` parses Lakebase and PostgreSQL address forms.
- `file_cache` and `file_lock` provide cross-process cache refresh.
- `log` initializes the shared Rust tracing policy.
