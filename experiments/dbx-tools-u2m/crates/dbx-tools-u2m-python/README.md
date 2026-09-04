# dbx-tools-u2m Python bindings

PyO3 bindings for the Rust U2M client. The extension uses a private Tokio runtime and releases the GIL while login, refresh, storage, or locking operations run.

Build and run the example:

```bash
python -m pip install maturin
maturin develop
DATABRICKS_CONFIG_PROFILE=DEFAULT python examples/token.py
```

```python
import requests
from dbx_tools_u2m import U2mClient

client = U2mClient(profile="DEFAULT")
token = client.token_or_login()
response = requests.get(
    f"{client.host}/api/2.0/clusters/list",
    headers={"Authorization": f"{token.token_type} {token.access_token}"},
)
```

Build with Cargo feature `postgres` and pass `postgres_url` to use the optional Postgres adapter. The generated wheel uses Python's stable ABI and supports CPython 3.10 and newer.
