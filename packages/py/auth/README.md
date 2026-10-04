# `dbx-tools-auth`

Python access to the provider-neutral authentication lifecycle owned by
`@dbx-tools/auth`. The package embeds a CommonJS bundle and executes it through
PythonMonkey's SpiderMonkey runtime. Token refresh, check-lock-recheck
coordination, login policy, and rejected-token handling stay in the JavaScript
implementation instead of being copied into Python.

Python supplies host capabilities through `dbx-tools-node-bindings`, which
aliases the normal Node imports during the committed Bun build:

- `node:fs` supplies the exact synchronous profile-file operations auth uses.
- `node:os`, `node:path`, and `node:crypto` supply home, path, and SHA-256 operations.
- Shared build-time shims cover only the Node built-ins reached by the auth
  graph. Third-party libraries and the real `@dbx-tools/core` implementation run
  unchanged on top of those built-ins.
- Shared TypeScript handles App detection and semantic CLI version checks; the
  auth source contains no Python-specific runtime callbacks.
- `MemoryCredentialStore` and `FileCredentialStore` remain Python adapters so
  file locking does not need a JavaScript core shim.
- The bundled TypeScript owns profile resolution, CLI U2M, PAT selection,
  lifecycle caching, and request-header generation.
- PAT profiles use their configured token directly without invoking the CLI.
- `create_databricks_cli_auth()` applies the same JavaScript profile-selection
  rules, including implicit preference for one matching CLI profile.

The embedded profile logic uses the same maintained `ini` parser and enhanced
default selection as the Node package: `__settings__.default_profile`, then
`DEFAULT`, then a sole profile, with an optional unique matching CLI-U2M
preference over an implicit M2M default. The JavaScript lifecycle adds the same
token cache, check-lock-recheck acquisition, automatic CLI login, and rejected
token handling used by Node callers.

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
headers = await auth.authenticate()
```

Custom provider and storage methods may still be native Python coroutines.
PythonMonkey converts them to JavaScript promises, then converts resolved token
records back to Python dictionaries.

Regenerate the committed SpiderMonkey bundle after changing its TypeScript
entry point or the shared lifecycle:

```sh
bun run auth:python-runtime
```

Tests and release preparation run `bun run auth:python-runtime:check` so a
lifecycle change cannot publish a stale embedded runtime.

## Modules

- `client` loads the bundled runtime and exposes the async `AuthClient` facade.
- `databricks_auth` resolves profiles and exposes CLI U2M, PAT, and complete
  request-header behavior from the bundled TypeScript implementation.
- `types` defines the provider, storage, token, and lifecycle contracts.
- `storage` provides memory and file-backed adapters.
