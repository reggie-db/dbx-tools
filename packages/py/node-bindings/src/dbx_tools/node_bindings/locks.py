from __future__ import annotations

import asyncio
import hashlib
import uuid
from pathlib import Path
from typing import Protocol

from filelock import AsyncFileLock

from .files import ensure_directory


class LeaseLocks(Protocol):
    """Generic keyed lease contract suitable for cross-language adapters."""

    async def acquire(self, key: str, timeout_ms: int) -> str: ...

    async def release(self, lease: str) -> None: ...


class MemoryLeaseLocks:
    """Keyed in-process leases backed by asyncio locks."""

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
    """Keyed cross-process leases backed by filelock."""

    def __init__(self, root: Path | str) -> None:
        self.root = Path(root).expanduser().resolve()
        self._leases: dict[str, AsyncFileLock] = {}

    async def acquire(self, key: str, timeout_ms: int) -> str:
        await ensure_directory(self.root)
        lock = AsyncFileLock(self.root / f"{_digest(key)}.lock")
        await lock.acquire(timeout=timeout_ms / 1000)
        lease = uuid.uuid4().hex
        self._leases[lease] = lock
        return lease

    async def release(self, lease: str) -> None:
        lock = self._leases.pop(lease, None)
        if lock:
            await lock.release()


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()
