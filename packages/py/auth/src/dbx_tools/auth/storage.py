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


class MemoryLeaseLocks:
    def __init__(self) -> None:
        self._locks: dict[str, asyncio.Lock] = {}
        self._leases: dict[str, asyncio.Lock] = {}

    async def acquire(self, key: str, timeout_ms: int) -> str:
        lock = self._locks.setdefault(key, asyncio.Lock())
        await asyncio.wait_for(lock.acquire(), timeout_ms / 1000)
        lease = uuid.uuid4().hex
        self._leases[lease] = lock
        return lease

    async def release(self, lease: str) -> None:
        lock = self._leases.pop(lease, None)
        if lock and lock.locked():
            lock.release()


class FileLeaseLocks:
    def __init__(self, root: Path | str) -> None:
        self.root = Path(root).expanduser().resolve()
        self._leases: dict[str, AsyncFileLock] = {}

    async def acquire(self, key: str, timeout_ms: int) -> str:
        await _ensure_directory(self.root)
        digest = hashlib.sha256(key.encode()).hexdigest()
        lock = AsyncFileLock(self.root / f"{digest}.lock")
        await lock.acquire(timeout=timeout_ms / 1000)
        lease = uuid.uuid4().hex
        self._leases[lease] = lock
        return lease

    async def release(self, lease: str) -> None:
        lock = self._leases.pop(lease, None)
        if lock:
            await lock.release()


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
        await _ensure_directory(self.root)
        await _ensure_directory(self.root / "locks")

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
        source = await _read_text(self.root / "token-cache.json")
        cache = json.loads(source) if source else {"version": 1, "tokens": {}}
        if cache.get("version") != 1 or not isinstance(cache.get("tokens"), dict):
            raise ValueError("Token cache must use version 1")
        return cache

    async def _write_cache(self, cache: dict[str, Any]) -> None:
        await _atomic_write_text(
            self.root / "token-cache.json",
            f"{json.dumps(cache, indent=2)}\n",
        )


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


async def _ensure_directory(path: Path, *, mode: int = 0o700) -> None:
    await asyncio.to_thread(path.mkdir, parents=True, exist_ok=True, mode=mode)


async def _read_text(path: Path) -> str | None:
    try:
        return await asyncio.to_thread(path.read_text, encoding="utf-8")
    except FileNotFoundError:
        return None


async def _atomic_write_text(path: Path, content: str, *, mode: int = 0o600) -> None:
    await _ensure_directory(path.parent)
    temporary = path.parent / f".{path.name}-{uuid.uuid4().hex}.tmp"
    try:
        await asyncio.to_thread(temporary.write_text, content, encoding="utf-8")
        await asyncio.to_thread(temporary.chmod, mode)
        await asyncio.to_thread(temporary.replace, path)
    finally:
        try:
            await asyncio.to_thread(temporary.unlink)
        except FileNotFoundError:
            pass
