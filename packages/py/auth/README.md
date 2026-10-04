# `dbx-tools-auth`

Python access to the provider-neutral authentication lifecycle owned by
`@dbx-tools/auth`. The package embeds a CommonJS bundle and executes it through
PythonMonkey's SpiderMonkey runtime. Token refresh, check-lock-recheck
coordination, login policy, and rejected-token handling stay in the JavaScript
implementation instead of being copied into Python.

Python supplies host capabilities through small protocols:

- `TokenProvider` acquires, refreshes, and interactively logs in credentials.
- `CredentialStore` persists tokens and returns explicit lock leases.
- `MemoryCredentialStore` uses `asyncio` locks.
- `FileCredentialStore` uses the maintained `filelock` package and preserves
  unrelated entries in `token-cache.json`.
- `open_browser()` uses Python's `webbrowser` library for future native OAuth
  provider adapters.

## Example

```python
from dbx_tools.auth import AuthClient, MemoryCredentialStore

auth = AuthClient("profile", provider, MemoryCredentialStore())
token = await auth.token()
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
- `types` defines the provider, storage, token, and lifecycle contracts.
- `storage` provides memory and file-backed adapters.
- `browser` opens authorization URLs through the Python standard library.
