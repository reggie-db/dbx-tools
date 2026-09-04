# dbx-tools-databricks-auth

Private generated Python bindings for the Rust `dbx-tools-databricks-auth`
package.

The [Rust package](../../rs/databricks-auth/README.md) owns U2M and M2M OAuth,
profile resolution, refresh, locking, and built-in credential storage.

```python
from dbx_tools.databricks_auth.bindings import (
    DatabricksAuthOptions,
    create_persistent_auth,
)

auth = await create_persistent_auth(
    DatabricksAuthOptions(profile="DEFAULT", prefer_user_to_machine=True)
)
token = await auth.token()
```

M2M reads the client secret from the selected Databricks profile or
`DATABRICKS_CLIENT_SECRET`.
