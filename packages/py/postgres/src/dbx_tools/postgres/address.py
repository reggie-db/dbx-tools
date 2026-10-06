"""Python address types backed by the public Node Lakebase parser."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from enum import Enum
from typing import TypeAlias

from ._generated.node.postgres.identity import (
    parse_address as _node_parse_address,
)
from ._generated.node.postgres.identity import (
    parse_resource_path as _node_parse_resource_path,
)


class NativeSslMode(Enum):
    """PostgreSQL SSL modes supported by the shared Lakebase address parser."""

    REQUIRE = "require"
    DISABLE = "disable"
    PREFER = "prefer"


SslMode: TypeAlias = NativeSslMode
SSL_MODES: tuple[str, ...] = tuple(mode.value for mode in NativeSslMode)


@dataclass(frozen=True, slots=True)
class ParsedAddress:
    """Normalized project, endpoint, database, user, host, and SSL address fields."""

    project: str | None = None
    branch: str | None = None
    endpoint: str | None = None
    endpoint_id: str | None = None
    database: str | None = None
    database_resource_id: str | None = None
    user: str | None = None
    host: str | None = None
    port: int | None = None
    ssl_mode: NativeSslMode | None = None


LakebaseConnectionInputs: TypeAlias = ParsedAddress


def parse_resource_path(input: str | None) -> ParsedAddress:
    """Parse a canonical Lakebase project, branch, endpoint, or database resource path."""

    return _from_node(_node_parse_resource_path(input))


def parse_address(input: str | None) -> ParsedAddress:
    """Parse a PostgreSQL URL, Lakebase resource path, hostname, or project ID."""

    return _from_node(_node_parse_address(input))


def _from_node(value: Mapping[str, object]) -> ParsedAddress:
    ssl_value = value.get("sslMode")
    port_value = value.get("port")
    ssl_mode = (
        next((mode for mode in NativeSslMode if mode.value == ssl_value), None)
        if isinstance(ssl_value, str)
        else None
    )
    return ParsedAddress(
        project=_string(value.get("project")),
        branch=_string(value.get("branch")),
        endpoint=_string(value.get("endpoint")),
        endpoint_id=_string(value.get("endpointId")),
        database=_string(value.get("database")),
        database_resource_id=_string(value.get("databaseResourceId")),
        user=_string(value.get("user")),
        host=_string(value.get("host")),
        port=int(port_value)
        if isinstance(port_value, (int, float)) and float(port_value).is_integer()
        else None,
        ssl_mode=ssl_mode,
    )


def _string(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


__all__ = [
    "SSL_MODES",
    "LakebaseConnectionInputs",
    "NativeSslMode",
    "ParsedAddress",
    "SslMode",
    "parse_address",
    "parse_resource_path",
]
