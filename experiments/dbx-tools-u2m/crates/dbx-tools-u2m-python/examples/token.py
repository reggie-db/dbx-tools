import os

from dbx_tools_u2m import U2mClient

client = U2mClient(profile=os.getenv("DATABRICKS_CONFIG_PROFILE"))
token = client.token_or_login()
print(
    {
        "profile": client.profile,
        "host": client.host,
        "token_type": token.token_type,
        "expiry": token.expiry,
    }
)
