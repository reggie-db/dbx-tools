import os

import asyncio

from dbx_tools_u2m_bindings import U2mOptions, create_persistent_auth


async def main() -> None:
    auth = await create_persistent_auth(
        U2mOptions(profile=os.getenv("DATABRICKS_CONFIG_PROFILE"))
    )
    token = await auth.token()
    status = auth.status()
    print(
        {
            "profile": status.profile,
            "host": status.host,
            "token_type": token.token_type,
            "expiry": token.expiry,
        }
    )


asyncio.run(main())
