from __future__ import annotations

from contextlib import contextmanager
from typing import Any

import pytest
from dbx_tools.postgres import (
    acquire_advisory_lock,
    acquire_advisory_lock_async,
    advisory_lock,
    advisory_lock_id,
    explicit_advisory_lock_id,
    try_advisory_transaction_lock,
)


class FakeResult:
    def __init__(self, value: bool) -> None:
        self.value = value

    def scalar_one(self) -> bool:
        return self.value


class FakeConnection:
    def __init__(self, values: list[bool] | None = None) -> None:
        self.values = list(values or [])
        self.queries: list[tuple[str, dict[str, object]]] = []

    def execute(self, statement: object, parameters: dict[str, object] | None = None) -> FakeResult:
        self.queries.append((str(statement), parameters or {}))
        return FakeResult(self.values.pop(0) if self.values else True)


class FakeAsyncConnection(FakeConnection):
    async def execute(
        self, statement: object, parameters: dict[str, object] | None = None
    ) -> FakeResult:
        return super().execute(statement, parameters)


class FakeEngine:
    def __init__(self, connection: FakeConnection) -> None:
        self.connection = connection
        self.connect_count = 0
        self.begin_count = 0

    @contextmanager
    def connect(self) -> Any:
        self.connect_count += 1
        yield self.connection

    @contextmanager
    def begin(self) -> Any:
        self.begin_count += 1
        yield self.connection


def test_advisory_lock_id_matches_node_contract() -> None:
    assert advisory_lock_id(["schema-install", "v2"]) == -6627415645816226415
    assert advisory_lock_id({"b": 2, "a": 1}) == 8289569017560903448
    assert advisory_lock_id(explicit_advisory_lock_id(2**64 - 1)) == -1


def test_session_context_uses_one_connection_and_unlocks() -> None:
    connection = FakeConnection()
    engine = FakeEngine(connection)

    with advisory_lock(engine, ["schema", 2]) as held:
        assert held is connection

    assert engine.connect_count == 1
    assert [query for query, _ in connection.queries] == [
        "SELECT pg_advisory_lock(:lock_id)",
        "SELECT pg_advisory_unlock(:lock_id)",
    ]


def test_try_transaction_lock_yields_none_when_busy() -> None:
    connection = FakeConnection([False])
    engine = FakeEngine(connection)

    with try_advisory_transaction_lock(engine, "migration") as held:
        assert held is None

    assert engine.begin_count == 1
    assert connection.queries[0][0] == "SELECT pg_try_advisory_xact_lock(:lock_id)"


def test_try_lock_reports_database_result() -> None:
    connection = FakeConnection([False])

    assert acquire_advisory_lock(connection, "busy", wait=False) is False


async def test_async_try_lock_uses_async_queryable() -> None:
    connection = FakeAsyncConnection([True])

    assert await acquire_advisory_lock_async(connection, "available", wait=False) is True
    assert connection.queries[0][0] == "SELECT pg_try_advisory_lock(:lock_id)"


def test_session_unlock_failure_is_reported() -> None:
    connection = FakeConnection([True, False])
    engine = FakeEngine(connection)

    with pytest.raises(RuntimeError, match="was not held"), advisory_lock(engine, "missing"):
        pass
