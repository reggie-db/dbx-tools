from __future__ import annotations

import json

from dbx_tools.auth import databricks_cli


async def test_cli_provider_requests_profile_token(monkeypatch) -> None:
    calls = []

    async def run_process(program, args, **kwargs):
        calls.append((program, args, kwargs))
        return {
            "exitCode": 0,
            "stdout": json.dumps(
                {
                    "access_token": "token",
                    "token_type": "Bearer",
                    "expiry": "2099-01-01T00:00:00Z",
                },
            ),
        }

    monkeypatch.setattr(databricks_cli, "run_process", run_process)

    token = await databricks_cli.DatabricksCliProvider("DEV").authenticate(1)

    assert token["accessToken"] == "token"
    assert calls[0][0] == "databricks"
    assert calls[0][1] == ["auth", "token", "--profile", "DEV", "--output", "json"]
    assert calls[0][2]["env"]["DATABRICKS_CONFIG_PROFILE"] == "DEV"

    await databricks_cli.DatabricksCliProvider("DEV").refresh(token)

    assert calls[1][1][-1] == "--force-refresh"
