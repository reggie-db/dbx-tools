# dbx-tools-core-rs

Generated Python bindings for Databricks authentication, runtime utilities, and
Lakebase address parsing from the `dbx-tools-core` Rust crate.

```python
from dbx_tools.core_rs.bindings import (
    DatabricksAuthOptions,
    create_persistent_auth,
)

auth = await create_persistent_auth(DatabricksAuthOptions())
token = await auth.token()
```

Inside a Databricks App, pass current request headers through
`DatabricksAuthOptions`. It prefers `app_obo` from the configured access-token
header, then falls back to `app_sp` using the ambient App service principal.
The header defaults to `authorization` with the standard `Bearer` scheme. OBO
tokens are returned directly without caching, while `app_sp` shares the M2M
implementation.

```python
auth = await create_persistent_auth(
    DatabricksAuthOptions(
        request_headers=dict(request.headers),
        access_token_header="x-forwarded-access-token",
    ),
)
```

Set `auth_type="app_obo"` or `auth_type="app_sp"`, or provide `profile`, to
override automatic App resolution.
