# dbx-tools-u2m Python bindings

Generated with Mozilla UniFFI from the same annotated Rust component as the Node bindings.

Build and run the example:

```bash
sh scripts/build.sh
DATABRICKS_CONFIG_PROFILE=DEFAULT python examples/token.py
```

```python
import asyncio
from dbx_tools_u2m_bindings import U2mOptions, create_persistent_auth

async def main():
    auth = await create_persistent_auth(U2mOptions(profile="DEFAULT"))
    await auth.challenge()
    token = await auth.token()
    refreshed = await auth.force_refresh_token()

asyncio.run(main())
```

Names mirror Go's `PersistentAuth`: `Challenge`, `Token`, and `ForceRefreshToken`. UniFFI renders them in Python snake case.
