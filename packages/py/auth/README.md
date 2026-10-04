# `dbx-tools-auth`

Python access to the provider-neutral authentication lifecycle owned by
`@dbx-tools/auth`. The package embeds a CommonJS bundle and executes it through
PythonMonkey's SpiderMonkey runtime. Token refresh, check-lock-recheck
coordination, login policy, and rejected-token handling stay in the JavaScript
implementation instead of being copied into Python.

The committed Bun build aliases normal Node imports to PythonMonkey shims that
call Python's standard library directly:

- `node:fs` supplies the exact synchronous profile-file operations auth uses.
- `node:os`, `node:path`, and `node:crypto` supply home, path, and SHA-256 operations.
- Shared build-time shims cover only the Node built-ins reached by the auth
  graph. Third-party libraries and workspace packages otherwise run unchanged.
- The Python build explicitly replaces `@dbx-tools/core/file-lock`'s
  `acquireFileLock` export with a `filelock.FileLock` handler. It keeps the same
  lease API and check-lock-recheck behavior while using the host Python
  process's OS lock instead of emulating a Node file descriptor.
- Shared TypeScript handles App detection and semantic CLI version checks; the
  auth source contains no Python-specific runtime callbacks.
- `create_databricks_cli_auth()` keeps credentials in process memory by default.
  `MemoryCredentialStore` and `FileCredentialStore` remain Python-facing
  adapters, and passing a file store opts into persistence. The bundled
  JavaScript store uses the registered Python flock override when it updates
  the shared token cache.
- The bundled TypeScript owns profile resolution, CLI U2M, PAT selection,
  lifecycle caching, and request-header generation.
- PAT profiles use their configured token directly without invoking the CLI.
- `create_databricks_cli_auth()` applies the same JavaScript profile-selection
  rules, including implicit preference for one matching CLI profile.

The embedded profile logic uses the same maintained `ini` parser and enhanced
default selection as the Node package: `__settings__.default_profile`, then
`DEFAULT`, then a sole profile, with an optional unique matching CLI-U2M
preference over an implicit M2M default. The JavaScript lifecycle adds the same
in-process token cache, check-lock-recheck acquisition, automatic CLI login, and
rejected-token handling used by Node callers.

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

To persist lifecycle credentials explicitly:

```python
from pathlib import Path

from dbx_tools.auth import FileCredentialStore, create_databricks_cli_auth

auth = await create_databricks_cli_auth(
    profile="DEFAULT",
    store=FileCredentialStore(Path.home() / ".databricks"),
)
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

## Debug logging

Set `LOG_LEVEL=debug` before starting Python to receive the same structured
JavaScript lifecycle logs through PythonMonkey's console bridge:

```sh
LOG_LEVEL=debug uv run python packages/py/auth/tests/auth_cli.py both --no-login
```

The output covers profile selection, provider and CLI decisions, locks, cache
reuse, refresh/login fallback, and generated header names. Credentials, client
secrets, authorization values, raw headers, cache contents, and HTTP bodies are
never logged.

## Modules

- `client` loads the bundled runtime and exposes the async `AuthClient` facade.
- `databricks_auth` resolves profiles and exposes CLI U2M, PAT, and complete
  request-header behavior from the bundled TypeScript implementation.
- `node_bindings` is generated from plain public functions exported by the
  configured Node package, using snake_case async Python wrappers.
- `types` defines the provider, storage, token, and lifecycle contracts.
- `storage` provides memory and file-backed adapters.
