from __future__ import annotations

import json

from dbx_tools.auth import databricks_cli


class Process:
    returncode = 0

    async def communicate(self):
        return (
            json.dumps(
                {
                    "access_token": "token",
                    "token_type": "Bearer",
                    "expiry": "2099-01-01T00:00:00Z",
                },
            ).encode(),
            b"",
        )


async def test_cli_provider_requests_profile_token(monkeypatch) -> None:
    calls = []

    async def execute(program, *args, **kwargs):
        calls.append((program, args, kwargs))
        return Process()

    monkeypatch.setattr(databricks_cli, "execute", execute)

    token = await databricks_cli.DatabricksCliProvider("DEV").authenticate(1)

    assert token["accessToken"] == "token"
    assert calls[0][0] == "databricks"
    assert calls[0][1] == ("auth", "token", "--profile", "DEV", "--output", "json")

    await databricks_cli.DatabricksCliProvider("DEV").refresh(token)

    assert calls[1][1][-1] == "--force-refresh"
