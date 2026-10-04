from __future__ import annotations

import asyncio
import hashlib
import json
import uuid
from pathlib import Path
from typing import Any

from filelock import AsyncFileLock

from .client import token_to_javascript
from .types import Token


class MemoryCredentialStore:
    def __init__(self) -> None:
        self._tokens: dict[str, Token] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._leases: dict[str, asyncio.Lock] = {}

    async def load(self, key: str) -> Token | None:
        token = self._tokens.get(key)
        return token_to_javascript(token) if token else None

    async def prepare_write(self) -> None: ...

    async def save(self, key: str, token: Token) -> None:
        self._tokens[key] = token_to_javascript(token)

    async def remove(self, key: str) -> None:
        self._tokens.pop(key, None)

    async def acquire_lock(self, key: str, timeout_ms: int) -> str:
        lock = self._locks.setdefault(key, asyncio.Lock())
        await asyncio.wait_for(lock.acquire(), timeout_ms / 1000)
        lease = uuid.uuid4().hex
        self._leases[lease] = lock
        return lease

    async def release_lock(self, lease: str) -> None:
        lock = self._leases.pop(lease, None)
        if lock and lock.locked():
            lock.release()

    def name(self) -> str:
        return "memory"


class FileCredentialStore:
    def __init__(self, root: Path | str | None = None) -> None:
        self.root = Path(root or Path.home() / ".databricks").expanduser().resolve()
        self._leases: dict[str, AsyncFileLock] = {}

    async def load(self, key: str) -> Token | None:
        await self.prepare_write()
        async with self._cache_lock():
            cache = await self._read_cache()
        value = cache["tokens"].get(key)
        return _deserialize_token(value)

    async def prepare_write(self) -> None:
        await asyncio.to_thread(self.root.mkdir, parents=True, exist_ok=True, mode=0o700)
        await asyncio.to_thread(
            (self.root / "locks").mkdir,
            parents=True,
            exist_ok=True,
            mode=0o700,
        )

    async def save(self, key: str, token: Token) -> None:
        await self.prepare_write()
        async with self._cache_lock():
            cache = await self._read_cache()
            cache["tokens"][key] = _serialize_token(token)
            await self._write_cache(cache)

    async def remove(self, key: str) -> None:
        await self.prepare_write()
        async with self._cache_lock():
            cache = await self._read_cache()
            cache["tokens"].pop(key, None)
            await self._write_cache(cache)

    async def acquire_lock(self, key: str, timeout_ms: int) -> str:
        await self.prepare_write()
        lock = AsyncFileLock(self.root / "locks" / f"{_digest(key)}.lock")
        await lock.acquire(timeout=timeout_ms / 1000)
        lease = uuid.uuid4().hex
        self._leases[lease] = lock
        return lease

    async def release_lock(self, lease: str) -> None:
        lock = self._leases.pop(lease, None)
        if lock:
            await lock.release()

    def name(self) -> str:
        return "file"

    def _cache_lock(self) -> AsyncFileLock:
        return AsyncFileLock(self.root / "locks" / "token-cache.lock")

    async def _read_cache(self) -> dict[str, Any]:
        path = self.root / "token-cache.json"
        try:
            text = await asyncio.to_thread(path.read_text, encoding="utf-8")
        except FileNotFoundError:
            return {"version": 1, "tokens": {}}
        cache = json.loads(text)
        if cache.get("version") != 1 or not isinstance(cache.get("tokens"), dict):
            raise ValueError("Token cache must use version 1")
        return cache

    async def _write_cache(self, cache: dict[str, Any]) -> None:
        temporary = self.root / f".token-cache-{uuid.uuid4().hex}.tmp"
        await asyncio.to_thread(
            temporary.write_text,
            f"{json.dumps(cache, indent=2)}\n",
            encoding="utf-8",
        )
        await asyncio.to_thread(temporary.chmod, 0o600)
        await asyncio.to_thread(temporary.replace, self.root / "token-cache.json")


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


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
