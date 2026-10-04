from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

from dbx_tools.auth import create_persistent_auth, normalize_host

APP_ENVIRONMENT = {"DBX_TOOLS_DATABRICKS_APP_ENV": "true"}


async def test_generated_function_wrapper_calls_embedded_runtime() -> None:
    assert await normalize_host("https://example.cloud.databricks.com/") == (
        "https://example.cloud.databricks.com"
    )


def test_generated_package_exposes_ambient_token_and_authenticate() -> None:
    script = """
import asyncio
import json
from dbx_tools.auth import authenticate, token

async def main():
    print(json.dumps({
        "token": await token(False),
        "headers": await authenticate(False),
    }, sort_keys=True))

asyncio.run(main())
"""
    environment = {
        **os.environ,
        "DATABRICKS_AUTH_TYPE": "pat",
        "DATABRICKS_CONFIG_FILE": "/tmp/dbx-tools-auth-ambient-test-missing",
        "DATABRICKS_HOST": "https://example.cloud.databricks.com",
        "DATABRICKS_TOKEN": "ambient-token",
    }
    environment.pop("DATABRICKS_WORKSPACE_ID", None)
    result = subprocess.run(
        [sys.executable, "-c", script],
        check=True,
        capture_output=True,
        text=True,
        env=environment,
    )
    output = json.loads(result.stdout)
    assert output["token"]["accessToken"] == "ambient-token"
    assert output["headers"] == {"authorization": "Bearer ambient-token"}


async def test_generated_object_proxy_exposes_authentication_methods() -> None:
    auth = await create_persistent_auth(
        {
            "host": "https://example.cloud.databricks.com",
            "workspaceId": "workspace-id",
            "requestHeaders": {"Authorization": "Bearer request-token"},
            "preferUserToMachine": True,
        },
        "memory",
        {"environment": APP_ENVIRONMENT},
    )

    assert await auth.authenticate(False) == {
        "authorization": "Bearer request-token",
        "x-databricks-workspace-id": "workspace-id",
    }
    assert await auth.request_headers_for_url(
        "https://example.cloud.databricks.com/api/2.0/clusters/list",
        False,
    ) == {
        "authorization": "Bearer request-token",
        "x-databricks-workspace-id": "workspace-id",
    }
    assert await auth.request_headers_for_url("https://example.com", False) == {}
    assert await auth.status() == {
        "profile": "DEFAULT",
        "host": "https://example.cloud.databricks.com",
        "storage": "memory",
    }
    assert await auth.workspace_id() == "workspace-id"
    assert await auth.auth_kind() == "app-on-behalf-of"


async def test_file_storage_uses_python_flock_and_preserves_entries(tmp_path: Path) -> None:
    cache = tmp_path / "token-cache.json"
    cache.write_text(
        json.dumps({"version": 1, "tokens": {"unrelated": {"custom": True}}}),
        encoding="utf-8",
    )

    async def authenticate(profile: str, token: str) -> None:
        auth = await create_persistent_auth(
            {
                "profile": profile,
                "host": "https://example.cloud.databricks.com",
                "authType": "pat",
                "accessToken": token,
                "cacheDir": str(tmp_path),
                "preferUserToMachine": True,
            },
            "file",
            {"environment": {}},
        )
        assert (await auth.token(False))["accessToken"] == token

    await asyncio.gather(
        authenticate("LEFT", "left-token"),
        authenticate("RIGHT", "right-token"),
    )

    saved = json.loads(cache.read_text(encoding="utf-8"))
    assert saved["tokens"]["unrelated"] == {"custom": True}
    assert len(saved["tokens"]) == 3
    lock_files = list((tmp_path / "locks").iterdir())
    assert lock_files
    assert all(path.suffix == ".flock" for path in lock_files)
