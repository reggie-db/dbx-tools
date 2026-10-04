# `dbx-tools-auth`

Python access to the authentication lifecycle implemented by `@dbx-tools/auth`.
The Python distribution is generated from the Node package and runs its bundled
CommonJS runtime through PythonMonkey. There is no separate Python auth
implementation to keep in sync.

## Usage

```python
from dbx_tools.auth import authenticate, create_persistent_auth, token

access_token = await token()
headers = await authenticate()

auth = await create_persistent_auth()
profile_token = await auth.token()
profile_headers = await auth.authenticate()
```

Use the top-level `token()` and `authenticate()` functions for normal ambient
authentication. They share one process-wide `PersistentAuth` instance, so
profile resolution, token caching, locking, and refresh state are reused.
Create an explicit auth object when you need custom options, storage, or injected
dependencies.

Generated function names use `snake_case`. Objects returned by JavaScript are
proxied automatically, so JavaScript methods such as `workspaceId()` and
`requestHeadersForUrl()` are available as async Python methods named
`workspace_id()` and `request_headers_for_url()`.

Authentication uses process memory by default. Pass `"file"` as the second
factory argument to use the shared Databricks token cache:

```python
auth = await create_persistent_auth(
    {"profile": "DEFAULT"},
    "file",
)
```

The generated runtime keeps the Node package's profile selection, lazy
Databricks CLI resolution, automatic login policy, token refresh, rejected-token
handling, and request-header generation. The Python build replaces the shared
file-lock function with `filelock.FileLock`, preserving the same
check-lock-recheck lifecycle with a native host-process lock.

`authenticate()` returns all request headers, including
`X-Databricks-Workspace-Id` when the resolved profile supplies a workspace ID.

## Generation

The package uses the full-package layout:

```toml
[tool.uv.build-backend]
module-name = "dbx_tools.auth"
module-root = "generated-src"

[tool.dbx_tools.node_bindings]
package = "@dbx-tools/auth"
layout = "package"
shim_root = "projen/shims/python-node"
```

Regenerate or verify the committed package from the repository root:

```sh
bun run auth:python-runtime
bun run auth:python-runtime:check
```

`bun run sync --watch` also regenerates the package when a workspace-backed Node
dependency, binding configuration, shim, or function override changes.

## Debugging

Set `LOG_LEVEL=debug` to receive the shared JavaScript lifecycle logs through
PythonMonkey:

```sh
LOG_LEVEL=debug uv run python packages/py/auth/tests/auth_cli.py both --no-login
```

The diagnostic command reports environment selection, the resolved profile,
token metadata, and generated headers. It redacts access tokens and
authorization headers unless `--show-sensitive` is passed.
