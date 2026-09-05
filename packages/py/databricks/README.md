# dbx-tools-databricks

Rust-generated Python bindings for shared Databricks runtime utilities.

```python
from dbx_tools.databricks import (
    databricks_cli_available,
    is_databricks_app,
)

if is_databricks_app():
    ...
```

`is_databricks_app()` honors `DBX_TOOLS_DATABRICKS_APP_ENV`, then validates
`DATABRICKS_APP_NAME`, `DATABRICKS_HOST`, and `DATABRICKS_APP_PORT`.
`databricks_cli_available()` caches whether `databricks auth --help` succeeds
for the process.

The implementation and complete behavior live in the
[Rust package](../../rs/databricks/README.md). Node workspace, filesystem,
cloud, network, and generated binding APIs are documented by
[`@dbx-tools/databricks`](../../js/node/databricks).
