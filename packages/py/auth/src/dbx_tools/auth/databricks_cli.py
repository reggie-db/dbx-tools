from __future__ import annotations

import json
import os
from typing import Any

from dbx_tools.node_bindings import run_process

from .types import Token


class DatabricksCliProvider:
    """U2M provider backed by the Databricks CLI."""

    def __init__(
        self,
        profile: str,
        executable: str | None = None,
        config_file: str | None = None,
    ) -> None:
        self.profile = profile
        self.executable = executable or os.getenv("DATABRICKS_CLI_PATH") or "databricks"
        self.environment = {
            **({"DATABRICKS_CONFIG_FILE": config_file} if config_file else {}),
            "DATABRICKS_CONFIG_PROFILE": profile,
        }

    async def authenticate(self, timeout_ms: int) -> Token:
        del timeout_ms
        return await self._token()

    async def login(self, timeout_ms: int) -> Token:
        result = await run_process(
            self.executable,
            [
                "auth",
                "login",
                "--profile",
                self.profile,
                "--timeout",
                f"{max(1, (timeout_ms + 999) // 1000)}s",
            ],
            env=self.environment,
        )
        if result["exitCode"] != 0:
            raise RuntimeError(
                result.get("stderr") or f"databricks auth login exited {result['exitCode']}",
            )
        return await self._token()

    async def refresh(self, token: Token) -> Token:
        del token
        return await self._token(force_refresh=True)

    def can_authenticate_silently(self) -> bool:
        return True

    async def _token(self, *, force_refresh: bool = False) -> Token:
        args = ["auth", "token", "--profile", self.profile, "--output", "json"]
        if force_refresh:
            args.append("--force-refresh")
        result = await run_process(self.executable, args, env=self.environment)
        if result["exitCode"] != 0:
            raise RuntimeError(
                result.get("stderr") or f"databricks auth token exited {result['exitCode']}",
            )
        try:
            value = json.loads(result.get("stdout", ""))
        except json.JSONDecodeError as error:
            raise RuntimeError("Databricks CLI token output was not JSON") from error
        access_token = _string(value.get("access_token") or value.get("accessToken"))
        if not access_token:
            raise RuntimeError("Databricks CLI token output had no access token")
        scopes = value.get("scopes")
        token: Token = {
            "accessToken": access_token,
            "tokenType": _string(value.get("token_type") or value.get("tokenType")) or "Bearer",
            "scopes": [str(scope) for scope in scopes] if isinstance(scopes, list) else [],
        }
        refresh_token = _string(value.get("refresh_token") or value.get("refreshToken"))
        expiry = _string(value.get("expiry") or value.get("expires_at"))
        if refresh_token:
            token["refreshToken"] = refresh_token
        if expiry:
            token["expiry"] = expiry
        return token


def _string(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None
