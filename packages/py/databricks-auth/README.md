# dbx-tools-databricks-auth

Generated Python bindings for the Rust `dbx-tools-databricks-auth`
package.

The [Rust package](../../rs/databricks-auth/README.md) owns U2M and M2M OAuth,
profile resolution and endpoint policy. Shared `dbx_tools.auth` owns OAuth,
refresh, locking, and built-in credential storage.

```python
from dbx_tools.databricks_auth import (
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

For lifecycle overrides, import `AuthOptions` from `dbx_tools.auth` and pass
`DatabricksAuthOptions(auth=AuthOptions(lock_timeout_seconds=10))`. This is the
same record accepted by generic OAuth providers. Omit `auth` for Rust defaults;
move former flattened timeout and callback-image fields into this shared record.

Custom stores implement `dbx_tools.auth.StorageAdapter`. Pass
`create_storage_handle(adapter)` to `create_persistent_auth_with_storage` to
preserve callback ownership across the native library boundary.
