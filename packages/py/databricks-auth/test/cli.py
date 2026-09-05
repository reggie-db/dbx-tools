import asyncio
import json
import sys

from dbx_tools.auth import AuthError, AuthOptions
from dbx_tools.databricks_auth import DatabricksAuthOptions, create_persistent_auth

profile = sys.argv[1] if len(sys.argv) > 1 else None
options = DatabricksAuthOptions(profile=profile)
auth_options = options.auth or AuthOptions()

print(
    json.dumps(
        {
            "language": "python",
            "profile": options.profile,
            "lockTimeoutSeconds": auth_options.lock_timeout_seconds,
            "loginTimeoutSeconds": auth_options.login_timeout_seconds,
            "refreshBufferSeconds": auth_options.refresh_buffer_seconds,
        }
    )
)


async def main() -> None:
    try:
        auth = await create_persistent_auth(options)
        status = auth.status()
        print(
            json.dumps(
                {
                    "profile": status.profile,
                    "host": status.host,
                    "storage": status.storage.name.lower(),
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
    except AuthError as error:
        print(str(getattr(error, "message", error)), file=sys.stderr)
        raise SystemExit(1) from None


asyncio.run(main())
