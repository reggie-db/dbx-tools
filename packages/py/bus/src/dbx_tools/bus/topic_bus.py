from __future__ import annotations

import asyncio
import inspect
import json
import math
import os
import platform
import re
import socket
import uuid
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Protocol, TypeAlias

from dbx_tools.core import fnv_hash, to_identifier, to_stable_key
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

SerializableValue: TypeAlias = (
    str | int | float | bool | None | list["SerializableValue"] | dict[str, "SerializableValue"]
)
TopicMetadata: TypeAlias = dict[str, SerializableValue]
TopicListener: TypeAlias = Callable[["TopicMessage"], Awaitable[None] | None]
TopicMetadataProvider: TypeAlias = Callable[[], Awaitable[TopicMetadata] | TopicMetadata]

_DEFAULT_CHANNEL = "dbx_tools_topic_bus"
_MAX_CHANNEL_LENGTH = 63
_CHANNEL_HASH_LENGTH = 6
_CHANNEL_FALLBACK = "bus"
_MAX_NOTIFY_BYTES = 7_900
_MIN_RECONNECT_DELAY = 0.25
_MAX_RECONNECT_DELAY = 5.0


class AsyncEngineLike(Protocol):
    def begin(self) -> Any: ...

    async def raw_connection(self) -> Any: ...


@dataclass(frozen=True, slots=True)
class TopicPublishInput:
    type: str
    body: SerializableValue
    metadata: TopicMetadata = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class TopicMessage:
    id: str
    topic: str
    type: str
    metadata: TopicMetadata
    body: SerializableValue
    published_at: str

    @property
    def publishedAt(self) -> str:
        return self.published_at

    def as_dict(self) -> dict[str, SerializableValue]:
        return {
            "id": self.id,
            "topic": self.topic,
            "type": self.type,
            "metadata": self.metadata,
            "body": self.body,
            "publishedAt": self.published_at,
        }


@dataclass(frozen=True, slots=True)
class PostgresTopicBusOptions:
    channel: object = _DEFAULT_CHANNEL
    metadata: TopicMetadata | TopicMetadataProvider | None = None
    on_error: Callable[[BaseException], None] | None = None


class PostgresTopicBus:
    def __init__(
        self,
        engine: AsyncEngine | AsyncEngineLike,
        options: PostgresTopicBusOptions | None = None,
        *,
        channel: object | None = None,
        metadata: TopicMetadata | TopicMetadataProvider | None = None,
        on_error: Callable[[BaseException], None] | None = None,
    ) -> None:
        configured = options or PostgresTopicBusOptions()
        channel_value = configured.channel if channel is None else channel
        self.engine = engine
        self.channel_name = channel_name(channel_value)
        self.metadata = configured.metadata if metadata is None else metadata
        self.on_error = on_error or configured.on_error or (lambda error: None)
        self._listeners: dict[str, set[TopicListener]] = {}
        self._raw_connection: Any | None = None
        self._driver_connection: Any | None = None
        self._start_lock = asyncio.Lock()
        self._reconnect_task: asyncio.Task[None] | None = None
        self._closed = False

    @property
    def channelName(self) -> str:
        return self.channel_name

    async def start(self) -> None:
        if self._driver_connection is not None:
            return
        if self._closed:
            raise RuntimeError("Postgres topic bus is closed")
        async with self._start_lock:
            if self._driver_connection is not None:
                return
            raw_connection = await self.engine.raw_connection()
            driver_connection = raw_connection.driver_connection
            try:
                await driver_connection.add_listener(self.channel_name, self._handle_notification)
                add_termination_listener = getattr(
                    driver_connection, "add_termination_listener", None
                )
                if add_termination_listener:
                    add_termination_listener(self._handle_termination)
            except BaseException:
                await _maybe_await(raw_connection.close())
                raise
            if self._closed:
                await driver_connection.remove_listener(
                    self.channel_name,
                    self._handle_notification,
                )
                await _maybe_await(raw_connection.close())
                raise RuntimeError("Postgres topic bus is closed")
            self._raw_connection = raw_connection
            self._driver_connection = driver_connection

    async def broadcast(
        self,
        topic: str,
        message_input: TopicPublishInput | Mapping[str, Any],
    ) -> TopicMessage:
        if not topic.strip():
            raise TypeError("Topic must not be empty")
        if self._closed:
            raise RuntimeError("Postgres topic bus is closed")
        publish = _publish_input(message_input)
        if not publish.type.strip():
            raise TypeError("Message type must not be empty")
        if not _is_serializable(publish.metadata) or not _is_serializable(publish.body):
            raise TypeError("Message metadata and body must be JSON serializable without coercion")
        automatic = await self._resolve_metadata()
        message = TopicMessage(
            id=str(uuid.uuid4()),
            topic=topic,
            type=publish.type,
            metadata={**automatic, **publish.metadata},
            body=publish.body,
            published_at=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        )
        encoded = json.dumps(message.as_dict(), separators=(",", ":"), allow_nan=False)
        if len(encoded.encode("utf-8")) > _MAX_NOTIFY_BYTES:
            raise ValueError(f"Postgres notification exceeds {_MAX_NOTIFY_BYTES} bytes")
        async with self.engine.begin() as connection:
            await connection.execute(
                text("SELECT pg_notify(:channel, :payload)"),
                {"channel": self.channel_name, "payload": encoded},
            )
        return message

    async def listen(self, topic: str, listener: TopicListener) -> Callable[[], Awaitable[None]]:
        if not topic.strip():
            raise TypeError("Topic must not be empty")
        await self.start()
        listeners = self._listeners.setdefault(topic, set())
        listeners.add(listener)

        async def unsubscribe() -> None:
            listeners.discard(listener)
            if not listeners:
                self._listeners.pop(topic, None)

        return unsubscribe

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._reconnect_task:
            self._reconnect_task.cancel()
            await asyncio.gather(self._reconnect_task, return_exceptions=True)
            self._reconnect_task = None
        raw_connection = self._raw_connection
        driver_connection = self._driver_connection
        self._raw_connection = None
        self._driver_connection = None
        self._listeners.clear()
        if driver_connection is not None:
            remove_termination_listener = getattr(
                driver_connection,
                "remove_termination_listener",
                None,
            )
            if remove_termination_listener:
                remove_termination_listener(self._handle_termination)
            try:
                await driver_connection.remove_listener(
                    self.channel_name,
                    self._handle_notification,
                )
            except Exception as error:
                self.on_error(error)
        if raw_connection is not None:
            await _maybe_await(raw_connection.close())

    async def _resolve_metadata(self) -> TopicMetadata:
        configured = self.metadata() if callable(self.metadata) else (self.metadata or {})
        if inspect.isawaitable(configured):
            configured = await configured
        if not _is_serializable(configured) or not isinstance(configured, dict):
            raise TypeError("Bus metadata must be JSON serializable without coercion")
        return {**_machine_metadata(), **configured}

    def _handle_notification(
        self,
        connection: object,
        process_id: int,
        channel: str,
        payload: str,
    ) -> None:
        del connection, process_id
        if channel != self.channel_name:
            return
        message = _decode(payload)
        if message is None:
            return
        for listener in tuple(self._listeners.get(message.topic, ())):
            asyncio.create_task(self._deliver(listener, message))

    async def _deliver(self, listener: TopicListener, message: TopicMessage) -> None:
        try:
            result = listener(message)
            if inspect.isawaitable(result):
                await result
        except Exception as error:
            self.on_error(error)

    def _handle_termination(self, connection: object) -> None:
        del connection
        if self._closed or not self._listeners or self._reconnect_task is not None:
            return
        raw_connection = self._raw_connection
        self._raw_connection = None
        self._driver_connection = None
        self._reconnect_task = asyncio.create_task(self._reconnect(raw_connection))

    async def _reconnect(self, raw_connection: object | None = None) -> None:
        delay = 0.0
        try:
            if raw_connection is not None:
                try:
                    await _maybe_await(raw_connection.close())
                except Exception as error:
                    self.on_error(error)
            while not self._closed and self._listeners:
                if delay:
                    await asyncio.sleep(delay)
                try:
                    await self.start()
                    return
                except Exception as error:
                    if self._closed:
                        return
                    self.on_error(error)
                    delay = (
                        _MIN_RECONNECT_DELAY if delay == 0 else min(delay * 2, _MAX_RECONNECT_DELAY)
                    )
        finally:
            self._reconnect_task = None


def channel_name(channel: object = _DEFAULT_CHANNEL) -> str:
    parts = list(channel) if isinstance(channel, (list, tuple)) else [channel]
    stable = "\0".join(to_stable_key(part) for part in parts)
    suffix = fnv_hash(stable, length=_CHANNEL_HASH_LENGTH)
    labels = [part for part in parts if isinstance(part, (str, int, float, bool))]
    body = to_identifier(*labels, delimiter="_")[: _MAX_CHANNEL_LENGTH - len(suffix) - 1].rstrip(
        "_"
    )
    prefix = body if re.match(r"^[A-Za-z_]", body) else f"{_CHANNEL_FALLBACK}_{body}"
    return re.sub(r"_+", "_", f"{prefix}_{suffix}")


def _publish_input(value: TopicPublishInput | Mapping[str, Any]) -> TopicPublishInput:
    if isinstance(value, TopicPublishInput):
        return value
    return TopicPublishInput(
        type=value.get("type", ""),
        metadata=dict(value.get("metadata") or {}),
        body=value.get("body"),
    )


def _decode(payload: str) -> TopicMessage | None:
    try:
        value = json.loads(payload)
    except (TypeError, json.JSONDecodeError):
        return None
    if not isinstance(value, dict) or not _is_serializable(value):
        return None
    required = ("id", "topic", "type", "metadata", "body", "publishedAt")
    if not all(key in value for key in required) or not isinstance(value["metadata"], dict):
        return None
    if not all(isinstance(value[key], str) for key in ("id", "topic", "type", "publishedAt")):
        return None
    return TopicMessage(
        id=value["id"],
        topic=value["topic"],
        type=value["type"],
        metadata=value["metadata"],
        body=value["body"],
        published_at=value["publishedAt"],
    )


def _machine_metadata() -> TopicMetadata:
    values: dict[str, SerializableValue | None] = {
        "project": _first_env(
            "DATABRICKS_APP_NAME",
            "DATABRICKS_BUNDLE_NAME",
            "PROJECT_NAME",
        ),
        "hostname": socket.gethostname(),
        "platform": platform.system().lower(),
        "environment": _env("PYTHON_ENV") or _env("NODE_ENV"),
        "appName": _env("DATABRICKS_APP_NAME"),
        "deploymentId": _env("DATABRICKS_APP_DEPLOYMENT_ID"),
        "databricksHost": _env("DATABRICKS_HOST"),
    }
    return {key: value for key, value in values.items() if value is not None}


def _env(name: str) -> str | None:
    value = os.environ.get(name)
    return value.strip() if value and value.strip() else None


def _first_env(*names: str) -> str | None:
    return next((value for name in names if (value := _env(name))), None)


def _is_serializable(value: object, seen: set[int] | None = None) -> bool:
    if value is None or isinstance(value, (str, bool, int)):
        return True
    if isinstance(value, float):
        return math.isfinite(value)
    seen = seen or set()
    identity = id(value)
    if identity in seen:
        return False
    if isinstance(value, list):
        seen.add(identity)
        try:
            return all(_is_serializable(item, seen) for item in value)
        finally:
            seen.remove(identity)
    if isinstance(value, dict) and all(isinstance(key, str) for key in value):
        seen.add(identity)
        try:
            return all(_is_serializable(item, seen) for item in value.values())
        finally:
            seen.remove(identity)
    return False


async def _maybe_await(value: object) -> object:
    return await value if inspect.isawaitable(value) else value


channelName = channel_name
