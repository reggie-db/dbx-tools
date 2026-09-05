import asyncio
import json

from dbx_tools.google_auth.bindings import GoogleAuthOptions, create_google_auth

"""Google ADC binding smoke test without exposing the access token."""


async def main() -> None:
    auth = await create_google_auth(GoogleAuthOptions())
    status = auth.status()
    print(
        json.dumps(
            {
                "credentialsPath": status.credentials_path,
                "storage": status.storage,
            }
        )
    )
    token = await auth.token()
    print(
        json.dumps(
            {
                "tokenType": token.token_type,
                "expiry": token.expiry,
                "scopes": token.scopes,
            }
        )
    )


asyncio.run(main())
