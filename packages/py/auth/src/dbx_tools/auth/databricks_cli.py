from __future__ import annotations

import asyncio
import json
import os
from typing import Any

from dbx_tools.core.bin import execute

from .types import Token


class DatabricksCliProvider:
    """U2M provider backed by the installed Databricks CLI."""

    def __init__(self, profile: str, executable: str | None = None) -> None:
        self.profile = profile
        self.executable = executable or os.getenv("DATABRICKS_CLI_PATH") or "databricks"

    async def authenticate(self, timeout_ms: int) -> Token:
        del timeout_ms
        return await self._token()

    async def login(self, timeout_ms: int) -> Token:
        process = await execute(
            self.executable,
            "auth",
            "login",
            "--profile",
            self.profile,
            "--timeout",
            f"{max(1, (timeout_ms + 999) // 1000)}s",
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await process.communicate()
        if process.returncode != 0:
            raise RuntimeError(_error(stderr, f"databricks auth login exited {process.returncode}"))
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
        process = await execute(
            self.executable,
            *args,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await process.communicate()
        if process.returncode != 0:
            raise RuntimeError(_error(stderr, f"databricks auth token exited {process.returncode}"))
        try:
            value = json.loads((stdout or b"").decode())
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
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


def _error(value: bytes | None, fallback: str) -> str:
    message = (value or b"").decode(errors="replace").strip()
    return message or fallback


def _string(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None
