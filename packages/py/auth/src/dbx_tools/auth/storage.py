from __future__ import annotations

from pathlib import Path
from typing import Any

from dbx_tools.js_runtime import (
    FileLeaseLocks,
    MemoryLeaseLocks,
    atomic_write_json,
    ensure_directory,
    read_json,
)

from .client import token_to_javascript
from .types import Token


class MemoryCredentialStore:
    def __init__(self) -> None:
        self._tokens: dict[str, Token] = {}
        self._locks = MemoryLeaseLocks()

    async def load(self, key: str) -> Token | None:
        token = self._tokens.get(key)
        return token_to_javascript(token) if token else None

    async def prepare_write(self) -> None: ...

    async def save(self, key: str, token: Token) -> None:
        self._tokens[key] = token_to_javascript(token)

    async def remove(self, key: str) -> None:
        self._tokens.pop(key, None)

    async def acquire_lock(self, key: str, timeout_ms: int) -> str:
        return await self._locks.acquire(key, timeout_ms)

    async def release_lock(self, lease: str) -> None:
        await self._locks.release(lease)

    def name(self) -> str:
        return "memory"


class FileCredentialStore:
    def __init__(self, root: Path | str | None = None) -> None:
        self.root = Path(root or Path.home() / ".databricks").expanduser().resolve()
        self._locks = FileLeaseLocks(self.root / "locks")

    async def load(self, key: str) -> Token | None:
        await self.prepare_write()
        lease = await self._locks.acquire("token-cache", 30_000)
        try:
            cache = await self._read_cache()
        finally:
            await self._locks.release(lease)
        value = cache["tokens"].get(key)
        return _deserialize_token(value)

    async def prepare_write(self) -> None:
        await ensure_directory(self.root)
        await ensure_directory(self.root / "locks")

    async def save(self, key: str, token: Token) -> None:
        await self.prepare_write()
        lease = await self._locks.acquire("token-cache", 30_000)
        try:
            cache = await self._read_cache()
            cache["tokens"][key] = _serialize_token(token)
            await self._write_cache(cache)
        finally:
            await self._locks.release(lease)

    async def remove(self, key: str) -> None:
        await self.prepare_write()
        lease = await self._locks.acquire("token-cache", 30_000)
        try:
            cache = await self._read_cache()
            cache["tokens"].pop(key, None)
            await self._write_cache(cache)
        finally:
            await self._locks.release(lease)

    async def acquire_lock(self, key: str, timeout_ms: int) -> str:
        return await self._locks.acquire(key, timeout_ms)

    async def release_lock(self, lease: str) -> None:
        await self._locks.release(lease)

    def name(self) -> str:
        return "file"

    async def _read_cache(self) -> dict[str, Any]:
        cache = await read_json(
            self.root / "token-cache.json",
            default={"version": 1, "tokens": {}},
        )
        if cache.get("version") != 1 or not isinstance(cache.get("tokens"), dict):
            raise ValueError("Token cache must use version 1")
        return cache

    async def _write_cache(self, cache: dict[str, Any]) -> None:
        await atomic_write_json(self.root / "token-cache.json", cache)


def _serialize_token(token: Token) -> dict[str, object]:
    return {
        "access_token": token["accessToken"],
        "token_type": token.get("tokenType", "Bearer"),
        **({"refresh_token": token["refreshToken"]} if "refreshToken" in token else {}),
        **({"expiry": token["expiry"]} if "expiry" in token else {}),
        **({"scopes": list(token["scopes"])} if token.get("scopes") else {}),
    }


def _deserialize_token(value: object) -> Token | None:
    if not isinstance(value, dict) or not isinstance(value.get("access_token"), str):
        return None
    token: Token = {
        "accessToken": value["access_token"],
        "tokenType": str(value.get("token_type") or "Bearer"),
        "scopes": [str(scope) for scope in value.get("scopes", [])],
    }
    if isinstance(value.get("refresh_token"), str):
        token["refreshToken"] = value["refresh_token"]
    if isinstance(value.get("expiry"), str):
        token["expiry"] = value["expiry"]
    return token
