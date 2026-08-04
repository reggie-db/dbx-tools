from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import pytest
from dbx_tools.postgres import PostgresTopicBus, TopicPublishInput, channel_name


class FakeSqlConnection:
    def __init__(self, queries: list[tuple[str, dict[str, str]]]) -> None:
        self.queries = queries

    async def execute(self, statement: Any, parameters: dict[str, str]) -> None:
        self.queries.append((str(statement), parameters))


class FakeDriverConnection:
    def __init__(self) -> None:
        self.listeners: dict[str, Any] = {}
        self.termination_listeners: list[Any] = []

    async def add_listener(self, channel: str, listener: Any) -> None:
        self.listeners[channel] = listener

    async def remove_listener(self, channel: str, listener: Any) -> None:
        if self.listeners.get(channel) == listener:
            self.listeners.pop(channel)

    def add_termination_listener(self, listener: Any) -> None:
        self.termination_listeners.append(listener)

    def remove_termination_listener(self, listener: Any) -> None:
        if listener in self.termination_listeners:
            self.termination_listeners.remove(listener)

    def emit(self, channel: str, payload: str) -> None:
        self.listeners[channel](self, 1, channel, payload)

    def terminate(self) -> None:
        for listener in tuple(self.termination_listeners):
            listener(self)


class FakeRawConnection:
    def __init__(self, driver_connection: FakeDriverConnection) -> None:
        self.driver_connection = driver_connection
        self.closed = False

    async def close(self) -> None:
        self.closed = True


class FakeEngine:
    def __init__(self, raw_connections: list[FakeRawConnection] | None = None) -> None:
        self.queries: list[tuple[str, dict[str, str]]] = []
        self.driver_connection = FakeDriverConnection()
        self.raw = FakeRawConnection(self.driver_connection)
        self.raw_connections = raw_connections or [self.raw]

    @asynccontextmanager
    async def begin(self) -> AsyncIterator[FakeSqlConnection]:
        yield FakeSqlConnection(self.queries)

    async def raw_connection(self) -> FakeRawConnection:
        return self.raw_connections.pop(0)


def test_channel_names_match_the_node_implementation() -> None:
    assert channel_name() == "dbx_tools_topic_bus_3kj9bt"
    assert channel_name("billing") == "billing_1m8m64"
    assert channel_name(["billing", "prod"]) == "billing_prod_091p2g"
    assert channel_name("billing_prod") == "billing_prod_3er7fp"
    assert channel_name({"a": 1}) == "bus_0xnqsa"
    assert channel_name("my-app") != channel_name("my_app")


@pytest.mark.asyncio
async def test_broadcast_uses_the_node_wire_envelope(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PROJECT_NAME", "demo")
    engine = FakeEngine()
    bus = PostgresTopicBus(engine, metadata={"source": "python"})
    message = await bus.broadcast(
        "orders",
        TopicPublishInput(type="order.updated", metadata={"source": "caller"}, body={"id": 7}),
    )
    assert message.topic == "orders"
    assert message.metadata["project"] == "demo"
    assert message.metadata["source"] == "caller"
    assert engine.queries[0][0] == "SELECT pg_notify(:channel, :payload)"
    encoded = json.loads(engine.queries[0][1]["payload"])
    assert encoded["publishedAt"] == message.publishedAt
    assert encoded["body"] == {"id": 7}


@pytest.mark.asyncio
async def test_listen_filters_topics_and_close_releases_connection() -> None:
    engine = FakeEngine()
    bus = PostgresTopicBus(engine)
    received: list[object] = []
    unsubscribe = await bus.listen("orders", lambda message: received.append(message.body))
    engine.driver_connection.emit(
        bus.channelName,
        json.dumps(
            {
                "id": "event-1",
                "topic": "orders",
                "type": "order.updated",
                "metadata": {},
                "body": {"id": 9},
                "publishedAt": "2026-08-03T00:00:00Z",
            }
        ),
    )
    engine.driver_connection.emit(
        bus.channelName,
        json.dumps(
            {
                "id": "event-2",
                "topic": "other",
                "type": "order.updated",
                "metadata": {},
                "body": {"id": 10},
                "publishedAt": "2026-08-03T00:00:00Z",
            }
        ),
    )
    await asyncio.sleep(0)
    assert received == [{"id": 9}]
    await unsubscribe()
    await bus.close()
    assert engine.raw.closed is True
    assert engine.driver_connection.listeners == {}


@pytest.mark.asyncio
async def test_broadcast_rejects_unserializable_and_oversized_values() -> None:
    bus = PostgresTopicBus(FakeEngine())
    with pytest.raises(TypeError):
        await bus.broadcast("invalid", {"type": "test", "body": float("inf")})
    with pytest.raises(ValueError):
        await bus.broadcast("large", {"type": "test", "body": "x" * 8_000})


@pytest.mark.asyncio
async def test_listener_reconnects_after_termination() -> None:
    first_driver = FakeDriverConnection()
    second_driver = FakeDriverConnection()
    first = FakeRawConnection(first_driver)
    second = FakeRawConnection(second_driver)
    engine = FakeEngine([first, second])
    bus = PostgresTopicBus(engine)
    await bus.listen("orders", lambda message: None)
    first_driver.terminate()
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    assert first.closed is True
    assert bus.channelName in second_driver.listeners
    await bus.close()
