# `dbx-tools-auth`

Python access to the provider-neutral authentication lifecycle owned by
`@dbx-tools/auth`. The package embeds a CommonJS bundle and executes it through
PythonMonkey's SpiderMonkey runtime. Token refresh, check-lock-recheck
coordination, login policy, and rejected-token handling stay in the JavaScript
implementation instead of being copied into Python.

Python supplies host capabilities through small protocols:

- `TokenProvider` acquires, refreshes, and interactively logs in credentials.
- `CredentialStore` persists tokens and returns explicit lock leases.
- `MemoryCredentialStore` and `FileCredentialStore` use the reusable lease and
  file adapters from `dbx-tools-node-bindings`.
- `DatabricksCliProvider` uses the installed Databricks CLI for U2M and PAT
  profiles through `dbx-tools-core` subprocess resolution.
- `create_databricks_cli_auth()` applies the same JavaScript profile-selection
  rules, including implicit preference for one matching CLI profile.

## Example

```python
from dbx_tools.auth import AuthClient, MemoryCredentialStore

auth = AuthClient("profile", provider, MemoryCredentialStore())
token = await auth.token()
```

For Databricks CLI-backed authentication:

```python
from dbx_tools.auth import create_databricks_cli_auth

auth = await create_databricks_cli_auth(profile="DEFAULT")
headers = await auth.headers()
```

Provider and storage methods may be native Python coroutines. PythonMonkey
converts them to JavaScript promises, then converts resolved token records back
to Python dictionaries.

Regenerate the committed SpiderMonkey bundle after changing its TypeScript
entry point or the shared lifecycle:

```sh
bun run auth:python-bridge
```

Tests and release preparation run `bun run auth:python-bridge:check` so a
lifecycle change cannot publish a stale embedded runtime.

## Modules

- `client` loads the bundled runtime and exposes the async `AuthClient` facade.
- `databricks_auth` resolves CLI profiles and exposes complete request headers.
- `databricks_cli` provides CLI U2M login/token refresh and PAT resolution.
- `types` defines the provider, storage, token, and lifecycle contracts.
- `storage` provides memory and file-backed adapters.
