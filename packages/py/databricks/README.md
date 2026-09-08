# dbx-tools-databricks

Python bindings for Databricks authentication and runtime utilities.

```python
from dbx_tools.databricks import (
    DatabricksAuthOptions,
    create_persistent_auth,
    create_persistent_auth_for_request,
)

auth = await create_persistent_auth(DatabricksAuthOptions())
token = await auth.token()
```

Inside a Databricks App, pass current request headers to
`create_persistent_auth_for_request`. It prefers `app_obo` from
`x-forwarded-access-token`, then falls back to `app_sp` using the ambient App
service principal. OBO tokens are returned directly without caching, while
`app_sp` shares the M2M implementation.

```python
auth = await create_persistent_auth_for_request(
    DatabricksAuthOptions(),
    dict(request.headers),
)
```

Set `auth_type="app_obo"` or `auth_type="app_sp"`, or provide `profile`, to
override automatic App resolution.
