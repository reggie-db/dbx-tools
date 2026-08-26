from __future__ import annotations

import asyncio
import datetime as dt
from collections.abc import AsyncIterator, Mapping, Sequence
from contextlib import asynccontextmanager
from decimal import Decimal
from typing import Any
from uuid import UUID

import pytest
from dbx_tools.graphiti.persistence import (
    DEFAULT_POSTGRES_JOURNAL_TABLE,
    DelegatingGraphDriver,
    GraphWrite,
    PostgresWriteStorage,
    WriteStorageDriver,
    _decode_value,
    _encode_value,
    is_write_query,
)
from dbx_tools.graphiti.server import _persistent_graphiti_constructor, persistence_configured
from graphiti_core.driver.driver import GraphDriver, GraphDriverSession, GraphProvider
from graphiti_core.driver.query_executor import Transaction


class MemoryStorage(WriteStorageDriver):
    def __init__(self, writes: Sequence[GraphWrite] = ()) -> None:
        self.writes = list(writes)
        self.setup_calls = 0
        self.closed = False

    async def setup(self) -> None:
        self.setup_calls += 1

    async def append(self, writes: Sequence[GraphWrite]) -> None:
        self.writes.extend(writes)

    async def load(self) -> list[GraphWrite]:
        return list(self.writes)

    async def close(self) -> None:
        self.closed = True


class RecordingConnection:
    def __init__(self) -> None:
        self.statements: list[str] = []

    async def execute(self, statement, *args) -> None:
        del args
        self.statements.append(str(statement))


class RecordingEngine:
    def __init__(self) -> None:
        self.connection = RecordingConnection()

    @asynccontextmanager
    async def begin(self):
        yield self.connection


class FakeTransaction(Transaction):
    def __init__(self, queries: list[tuple[str, Mapping[str, Any]]]) -> None:
        self.queries = queries

    async def run(self, query: str, **kwargs: Any) -> Any:
        self.queries.append((query, kwargs))
        return query


class FakeSession(GraphDriverSession):
    provider = GraphProvider.KUZU

    def __init__(self, queries: list[tuple[str, Mapping[str, Any]]]) -> None:
        self.queries = queries
        self.closed = False

    async def __aexit__(self, exc_type, exc, tb):
        await self.close()

    async def run(self, query: str, **kwargs: Any) -> Any:
        self.queries.append((query, kwargs))
        return query

    async def close(self) -> None:
        self.closed = True

    async def execute_write(self, func, *args, **kwargs):
        return await func(FakeTransaction(self.queries), *args, **kwargs)


class FakeDriver(GraphDriver):
    provider = GraphProvider.KUZU

    def __init__(self) -> None:
        super().__init__()
        self._database = "memory"
        self.queries: list[tuple[str, Mapping[str, Any]]] = []
        self.build_calls: list[bool] = []
        self.closed = False
        self.operation = object()

    @property
    def entity_node_ops(self):
        return self.operation

    async def execute_query(self, cypher_query_: str, **kwargs: Any) -> Any:
        self.queries.append((cypher_query_, kwargs))
        return cypher_query_

    def session(self, database: str | None = None) -> GraphDriverSession:
        del database
        return FakeSession(self.queries)

    async def close(self) -> None:
        self.closed = True

    async def delete_all_indexes(self) -> None:
        return None

    async def build_indices_and_constraints(self, delete_existing: bool = False) -> None:
        self.build_calls.append(delete_existing)

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[Transaction]:
        yield FakeTransaction(self.queries)

    def build_fulltext_query(
        self,
        query: str,
        group_ids: list[str] | None = None,
        max_query_length: int = 128,
    ) -> str:
        return f"{query}:{group_ids}:{max_query_length}"


def test_write_classifier_distinguishes_graph_mutations() -> None:
    assert is_write_query("MATCH (n) SET n.name = $name RETURN n")
    assert is_write_query("UNWIND $nodes AS node MERGE (n {uuid: node.uuid})")
    assert is_write_query("MATCH (n) DETACH DELETE n")
    assert not is_write_query("MATCH (n) RETURN n.created_at")


def test_postgres_journal_provisions_qualified_schema() -> None:
    async def run() -> None:
        engine = RecordingEngine()
        storage = PostgresWriteStorage(
            engine,  # type: ignore[arg-type]
            table=DEFAULT_POSTGRES_JOURNAL_TABLE,
        )

        await storage.setup()

        assert engine.connection.statements[0] == (
            'CREATE SCHEMA IF NOT EXISTS "dbx_tools_graphiti"'
        )
        assert 'CREATE TABLE IF NOT EXISTS "dbx_tools_graphiti"."graphiti_write_journal"' in (
            engine.connection.statements[1]
        )

    asyncio.run(run())


def test_delegate_journals_writes_but_not_reads() -> None:
    async def run() -> None:
        delegate = FakeDriver()
        storage = MemoryStorage()
        driver = DelegatingGraphDriver(delegate, storage)

        await driver.execute_query("MATCH (n) RETURN n", limit=1)
        await driver.execute_query("MERGE (n {uuid: $uuid})", uuid="node-1")

        assert delegate.queries == [
            ("MATCH (n) RETURN n", {"limit": 1}),
            ("MERGE (n {uuid: $uuid})", {"uuid": "node-1"}),
        ]
        assert storage.writes == [
            GraphWrite(query="MERGE (n {uuid: $uuid})", parameters={"uuid": "node-1"})
        ]
        assert driver.provider is GraphProvider.KUZU
        assert driver.entity_node_ops is delegate.operation

    asyncio.run(run())


def test_journal_failure_prevents_graph_mutation() -> None:
    class FailingStorage(MemoryStorage):
        async def append(self, writes: Sequence[GraphWrite]) -> None:
            del writes
            raise RuntimeError("journal unavailable")

    async def run() -> None:
        delegate = FakeDriver()
        driver = DelegatingGraphDriver(delegate, FailingStorage())

        with pytest.raises(RuntimeError, match="journal unavailable"):
            await driver.execute_query("CREATE (n {uuid: $uuid})", uuid="node-1")

        assert delegate.queries == []

    asyncio.run(run())


def test_delegate_failure_retains_write_ahead_record() -> None:
    class FailingDriver(FakeDriver):
        async def execute_query(self, cypher_query_: str, **kwargs: Any) -> Any:
            del cypher_query_, kwargs
            raise RuntimeError("graph unavailable")

    async def run() -> None:
        storage = MemoryStorage()
        driver = DelegatingGraphDriver(FailingDriver(), storage)

        with pytest.raises(RuntimeError, match="graph unavailable"):
            await driver.execute_query("CREATE (n {uuid: $uuid})", uuid="node-1")

        assert storage.writes == [
            GraphWrite(query="CREATE (n {uuid: $uuid})", parameters={"uuid": "node-1"})
        ]

    asyncio.run(run())


def test_hydration_clears_and_replays_once(monkeypatch) -> None:
    async def run() -> None:
        cleared: list[GraphDriver] = []

        async def clear(driver: GraphDriver) -> None:
            cleared.append(driver)

        monkeypatch.setattr("dbx_tools.graphiti.persistence.clear_data", clear)
        delegate = FakeDriver()
        storage = MemoryStorage(
            [
                GraphWrite(
                    sequence=1,
                    query="MERGE (n {uuid: $uuid})",
                    parameters={"uuid": "node-1"},
                )
            ]
        )
        driver = DelegatingGraphDriver(delegate, storage)

        await driver.build_indices_and_constraints()
        await driver.build_indices_and_constraints()

        assert delegate.build_calls == [False, False]
        assert cleared == [delegate]
        assert delegate.queries == [
            ("MERGE (n {uuid: $uuid})", {"uuid": "node-1"}),
        ]
        assert storage.setup_calls == 1
        assert len(storage.writes) == 1

    asyncio.run(run())


def test_transaction_journals_only_after_commit() -> None:
    async def run() -> None:
        storage = MemoryStorage()
        driver = DelegatingGraphDriver(FakeDriver(), storage)

        async with driver.transaction() as transaction:
            await transaction.run("MATCH (n) RETURN n")
            await transaction.run("CREATE (n {uuid: $uuid})", uuid="node-1")

        assert storage.writes == [
            GraphWrite(query="CREATE (n {uuid: $uuid})", parameters={"uuid": "node-1"})
        ]

        with pytest.raises(RuntimeError):
            async with driver.transaction() as transaction:
                await transaction.run("CREATE (n {uuid: $uuid})", uuid="node-2")
                raise RuntimeError("roll back")

        assert len(storage.writes) == 1

    asyncio.run(run())


def test_session_execute_write_records_committed_attempt() -> None:
    async def run() -> None:
        storage = MemoryStorage()
        driver = DelegatingGraphDriver(FakeDriver(), storage)

        async with driver.session() as session:
            await session.run("MATCH (n) DELETE n")

            async def write(transaction: Transaction) -> None:
                await transaction.run("MERGE (n {uuid: $uuid})", uuid="node-1")

            await session.execute_write(write)

        assert [write.query for write in storage.writes] == [
            "MATCH (n) DELETE n",
            "MERGE (n {uuid: $uuid})",
        ]

    asyncio.run(run())


def test_journal_codec_round_trips_supported_graphiti_values() -> None:
    value = {
        "datetime": dt.datetime(2026, 8, 13, 12, 30, tzinfo=dt.timezone.utc),
        "date": dt.date(2026, 8, 13),
        "time": dt.time(12, 30),
        "duration": dt.timedelta(seconds=9.5),
        "decimal": Decimal("3.14"),
        "uuid": UUID("44e7b6c1-719f-4aa0-a617-e05242ad2e63"),
        "bytes": b"graphiti",
        "nested": [1, {"ok": True}],
        "tag_collision": {"__graphiti_type__": "domain-value"},
    }

    assert _decode_value(_encode_value(value)) == value


def test_persistent_constructor_wraps_any_explicit_driver(monkeypatch) -> None:
    storage = MemoryStorage()
    delegate = FakeDriver()
    captured: dict[str, Any] = {}

    def graphiti_constructor(*args: Any, **kwargs: Any) -> object:
        captured.update(kwargs)
        return object()

    monkeypatch.setattr("dbx_tools.graphiti.server._postgres_storage", lambda: storage)

    _persistent_graphiti_constructor(graphiti_constructor)(graph_driver=delegate)

    driver = captured["graph_driver"]
    assert isinstance(driver, DelegatingGraphDriver)
    assert driver.delegate is delegate


def test_persistence_activation_uses_postgres_environment() -> None:
    assert persistence_configured({"PGHOST": "database.example"})
    assert persistence_configured({"JOURNAL_DATABASE_URL": "postgresql://example/db"})
    assert not persistence_configured({"PGHOST": "  "})
    assert not persistence_configured({})
