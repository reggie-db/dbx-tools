# dbx-tools-client

Python bindings for the Rust-backed Databricks runtime and authentication
client.

```python
from dbx_tools.client import (
    DatabricksAuthOptions,
    create_persistent_auth,
    create_persistent_auth_for_request,
)

auth = await create_persistent_auth(DatabricksAuthOptions())
token = await auth.token()
```

The package supports Databricks App detection, CLI token access, U2M browser
OAuth, M2M client credentials, PATs, profile resolution, and file, memory, or
caller-provided credential storage.

Inside an App, pass the current request headers to
`create_persistent_auth_for_request`. It prefers `app_obo` from
`x-forwarded-access-token`, then falls back to `app_sp` from the ambient App
service-principal variables. OBO tokens are returned directly without caching.

```python
auth = await create_persistent_auth_for_request(
    DatabricksAuthOptions(),
    dict(request.headers),
)
```

Set `auth_type="app_obo"` or `auth_type="app_sp"`, or provide `profile`, to
force a source.

Install with `pip install dbx-tools-client`.
