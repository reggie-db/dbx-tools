# `dbx-tools-auth`

Python access to the authentication lifecycle implemented by `@dbx-tools/auth`.
The Python distribution is generated from the Node package and runs its bundled
CommonJS runtime through PythonMonkey. There is no separate Python auth
implementation to keep in sync.

## Usage

```python
from dbx_tools.auth import (
    DatabricksAuthOptions,
    create_auth_client,
    create_persistent_auth,
)

auth = await create_auth_client()
access_token = await auth.token()
headers = await auth.authenticate()

profile_auth = await create_persistent_auth()
profile_token = await profile_auth.token()
profile_headers = await profile_auth.authenticate()

configured = await create_persistent_auth(DatabricksAuthOptions(profile="DEFAULT"))
keyword_configured = await create_persistent_auth(profile="DEFAULT")
```

Use `create_auth_client()` for normal ambient authentication. It returns a
narrow client with `token()` and `authenticate()` backed by one process-wide
authentication lifecycle, so profile resolution, token caching, locking, and
refresh state are reused.
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

The generator uses the TypeScript type checker for every function parameter, so
Python functions retain the Node parameter names and equivalent Python types.
Supported record types become keyword-only Python dataclasses, including nested
records. When the Node package exports a same-named companion with a
`defaults()` method, those values become the dataclass defaults. A trailing
optional record can be passed as the dataclass, a dictionary, or direct
snake-case keyword fields. Generation fails fast when a type cannot be
represented safely in Python.

Generated return contracts are typed as well. `create_auth_client()` returns an
`AuthClient` protocol, `create_persistent_auth()` returns `PersistentAuth`, and
token/profile records use exported `TypedDict` response types instead of `Any`.

## Debugging

Set `LOG_LEVEL=debug` to receive the shared JavaScript lifecycle logs through
PythonMonkey:

```sh
LOG_LEVEL=debug uv run python packages/py/auth/tests/auth_cli.py both --no-login
```

The diagnostic command reports environment selection, the resolved profile,
token metadata, and generated headers. It redacts access tokens and
authorization headers unless `--show-sensitive` is passed.
