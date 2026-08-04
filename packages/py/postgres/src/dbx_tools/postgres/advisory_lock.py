from __future__ import annotations

import hashlib
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager, contextmanager
from dataclasses import dataclass
from typing import Protocol

from dbx_tools.core import to_stable_key
from sqlalchemy import text
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine


@dataclass(frozen=True, slots=True)
class ExplicitAdvisoryLockId:
    value: int


class SyncQueryable(Protocol):
    def execute(self, statement: object, parameters: dict[str, object] | None = None) -> object: ...


class AsyncQueryable(Protocol):
    async def execute(
        self, statement: object, parameters: dict[str, object] | None = None
    ) -> object: ...


def advisory_lock_id(key: object) -> int:
    if isinstance(key, ExplicitAdvisoryLockId):
        return _signed_64(key.value)
    parts = key if isinstance(key, (list, tuple)) else [key]
    canonical = "\0".join(to_stable_key(part) for part in parts)
    return int.from_bytes(hashlib.sha256(canonical.encode()).digest()[:8], "big", signed=True)


def explicit_advisory_lock_id(value: int) -> ExplicitAdvisoryLockId:
    return ExplicitAdvisoryLockId(value)


def acquire_advisory_lock(
    connection: SyncQueryable,
    key: object,
    *,
    transaction: bool = False,
    wait: bool = True,
) -> bool:
    function = _function_name(transaction=transaction, wait=wait)
    result = connection.execute(
        text(f"SELECT {function}(:lock_id)"), {"lock_id": advisory_lock_id(key)}
    )
    return True if wait else bool(result.scalar_one())


async def acquire_advisory_lock_async(
    connection: AsyncQueryable,
    key: object,
    *,
    transaction: bool = False,
    wait: bool = True,
) -> bool:
    function = _function_name(transaction=transaction, wait=wait)
    result = await connection.execute(
        text(f"SELECT {function}(:lock_id)"), {"lock_id": advisory_lock_id(key)}
    )
    return True if wait else bool(result.scalar_one())


def release_advisory_lock(connection: SyncQueryable, key: object) -> None:
    lock_id = advisory_lock_id(key)
    result = connection.execute(text("SELECT pg_advisory_unlock(:lock_id)"), {"lock_id": lock_id})
    if result.scalar_one() is not True:
        raise RuntimeError(f"Postgres advisory lock {lock_id} was not held by this connection")


async def release_advisory_lock_async(connection: AsyncQueryable, key: object) -> None:
    lock_id = advisory_lock_id(key)
    result = await connection.execute(
        text("SELECT pg_advisory_unlock(:lock_id)"), {"lock_id": lock_id}
    )
    if result.scalar_one() is not True:
        raise RuntimeError(f"Postgres advisory lock {lock_id} was not held by this connection")


@contextmanager
def advisory_lock(engine: Engine, key: object) -> Iterator[Connection]:
    with engine.connect() as connection:
        acquire_advisory_lock(connection, key)
        failure: Exception | None = None
        try:
            yield connection
        except Exception as error:  # noqa: BLE001
            failure = error
        unlock_failure = _capture_release(connection, key)
        if failure is not None:
            if unlock_failure is not None:
                failure.add_note(f"Advisory lock release also failed: {unlock_failure}")
            raise failure
        if unlock_failure is not None:
            raise unlock_failure


@contextmanager
def try_advisory_lock(engine: Engine, key: object) -> Iterator[Connection | None]:
    with engine.connect() as connection:
        if not acquire_advisory_lock(connection, key, wait=False):
            yield None
            return
        failure: Exception | None = None
        try:
            yield connection
        except Exception as error:  # noqa: BLE001
            failure = error
        unlock_failure = _capture_release(connection, key)
        if failure is not None:
            if unlock_failure is not None:
                failure.add_note(f"Advisory lock release also failed: {unlock_failure}")
            raise failure
        if unlock_failure is not None:
            raise unlock_failure


@contextmanager
def advisory_transaction_lock(engine: Engine, key: object) -> Iterator[Connection]:
    with engine.begin() as connection:
        acquire_advisory_lock(connection, key, transaction=True)
        yield connection


@contextmanager
def try_advisory_transaction_lock(engine: Engine, key: object) -> Iterator[Connection | None]:
    with engine.begin() as connection:
        if not acquire_advisory_lock(connection, key, transaction=True, wait=False):
            yield None
            return
        yield connection


@asynccontextmanager
async def advisory_lock_async(engine: AsyncEngine, key: object) -> AsyncIterator[AsyncConnection]:
    async with engine.connect() as connection:
        await acquire_advisory_lock_async(connection, key)
        failure: Exception | None = None
        try:
            yield connection
        except Exception as error:  # noqa: BLE001
            failure = error
        unlock_failure = await _capture_release_async(connection, key)
        if failure is not None:
            if unlock_failure is not None:
                failure.add_note(f"Advisory lock release also failed: {unlock_failure}")
            raise failure
        if unlock_failure is not None:
            raise unlock_failure


@asynccontextmanager
async def try_advisory_lock_async(
    engine: AsyncEngine, key: object
) -> AsyncIterator[AsyncConnection | None]:
    async with engine.connect() as connection:
        if not await acquire_advisory_lock_async(connection, key, wait=False):
            yield None
            return
        failure: Exception | None = None
        try:
            yield connection
        except Exception as error:  # noqa: BLE001
            failure = error
        unlock_failure = await _capture_release_async(connection, key)
        if failure is not None:
            if unlock_failure is not None:
                failure.add_note(f"Advisory lock release also failed: {unlock_failure}")
            raise failure
        if unlock_failure is not None:
            raise unlock_failure


@asynccontextmanager
async def advisory_transaction_lock_async(
    engine: AsyncEngine, key: object
) -> AsyncIterator[AsyncConnection]:
    async with engine.begin() as connection:
        await acquire_advisory_lock_async(connection, key, transaction=True)
        yield connection


@asynccontextmanager
async def try_advisory_transaction_lock_async(
    engine: AsyncEngine, key: object
) -> AsyncIterator[AsyncConnection | None]:
    async with engine.begin() as connection:
        if not await acquire_advisory_lock_async(connection, key, transaction=True, wait=False):
            yield None
            return
        yield connection


def _function_name(*, transaction: bool, wait: bool) -> str:
    if transaction:
        return "pg_advisory_xact_lock" if wait else "pg_try_advisory_xact_lock"
    return "pg_advisory_lock" if wait else "pg_try_advisory_lock"


def _signed_64(value: int) -> int:
    return ((value + 2**63) % 2**64) - 2**63


def _capture_release(connection: SyncQueryable, key: object) -> Exception | None:
    try:
        release_advisory_lock(connection, key)
    except Exception as error:  # noqa: BLE001
        return error
    return None


async def _capture_release_async(connection: AsyncQueryable, key: object) -> Exception | None:
    try:
        await release_advisory_lock_async(connection, key)
    except Exception as error:  # noqa: BLE001
        return error
    return None
