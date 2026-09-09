import json
import sys

from dbx_tools.core_rs.bindings import canonical_scopes, credential_key

scopes = canonical_scopes(sys.argv[1:])
print(
    json.dumps(
        {
            "provider": "example",
            "profile": None,
            "scopes": scopes,
            "credentialKey": credential_key("example", None, scopes),
        }
    )
)
