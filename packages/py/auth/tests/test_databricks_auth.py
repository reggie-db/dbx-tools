from __future__ import annotations

from pathlib import Path

from dbx_tools.auth import create_databricks_cli_auth


def _write_cli(path: Path, access_token: str) -> Path:
    path.write_text(
        "#!/bin/sh\n"
        f'printf \'%s\\n\' \'{{"access_token":"{access_token}","token_type":"Bearer"}}\'\n',
        encoding="utf-8",
    )
    path.chmod(0o755)
    return path


async def test_profile_selection_prefers_matching_cli_profile(tmp_path: Path) -> None:
    config = tmp_path / "config"
    config.write_text(
        """[__settings__]
default_profile = service

[service]
host = https://example.cloud.databricks.com
client_id = service-id
client_secret = secret

[user]
host = https://example.cloud.databricks.com
workspace_id = workspace-id
auth_type = databricks-cli
""",
        encoding="utf-8",
    )

    auth = await create_databricks_cli_auth(config_file=config, cache_dir=tmp_path / "cache")

    assert auth.status().profile == "user"
    assert auth.status().host == "https://example.cloud.databricks.com"
    assert auth.status().workspace_id == "workspace-id"
    assert auth.status().storage == "file"
    assert auth.auth_kind() == "user-to-machine"


async def test_headers_include_workspace_id(tmp_path: Path) -> None:
    config = tmp_path / "config"
    config.write_text(
        """[DEFAULT]
host = https://example.cloud.databricks.com
workspace_id = workspace-id
auth_type = databricks-cli
""",
        encoding="utf-8",
    )

    auth = await create_databricks_cli_auth(
        config_file=config,
        cache_dir=tmp_path / "cache",
        executable=str(_write_cli(tmp_path / "databricks", "token")),
    )

    assert await auth.authenticate(False) == {
        "authorization": "Bearer token",
        "x-databricks-workspace-id": "workspace-id",
    }
    assert await auth.request_headers_for_url(
        "https://example.cloud.databricks.com/api/2.0/clusters/list",
        False,
    ) == {
        "authorization": "Bearer token",
        "x-databricks-workspace-id": "workspace-id",
    }
    assert await auth.request_headers_for_url("https://example.com", False) == {}


async def test_pat_uses_profile_token_without_cli(tmp_path: Path) -> None:
    config = tmp_path / "config"
    config.write_text(
        """[PAT]
host = https://example.cloud.databricks.com
auth_type = pat
token = profile-token
""",
        encoding="utf-8",
    )

    auth = await create_databricks_cli_auth(
        profile="PAT",
        config_file=config,
        cache_dir=tmp_path / "cache",
        executable=str(tmp_path / "must-not-run"),
    )

    assert await auth.authenticate(False) == {
        "authorization": "Bearer profile-token",
    }
