# dbx-tools-client

Databricks runtime and authentication client.

Key features:

- Databricks App detection and CLI token access.
- U2M browser OAuth, M2M client credentials, and PAT authentication.
- Profile, account, workspace, scope, and endpoint resolution.
- Shared token lifecycle with file, memory, or caller-provided storage.
- Cross-process credential locking through `dbx-tools-core`.
- UniFFI bindings published as `@dbx-tools/client` and `dbx-tools-client`.

Databricks-specific authentication lives under `src/auth`. Reusable OAuth flows
and templates live under `src/oauth`. Credential records, token lifecycle, and
storage live under `src/credentials`.

Outside Databricks Apps, automatic U2M uses
`databricks auth token --profile` when the CLI is available and falls back to
the native browser flow otherwise. Inside an App, automatic storage uses memory
and does not invoke the CLI. M2M always uses the native client-credentials
flow.

Inside an App, `create_persistent_auth_for_request` prefers `app_obo` when its
request headers contain `x-forwarded-access-token`, then falls back to `app_sp` from
`DATABRICKS_HOST`, `DATABRICKS_CLIENT_ID`, and `DATABRICKS_CLIENT_SECRET`.
OBO tokens are returned directly without caching because the App front door
refreshes them per request. Set `auth_type` or `profile` explicitly to override
automatic App resolution.
