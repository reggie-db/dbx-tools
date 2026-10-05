"""Lakebase address types and parsers implemented in Python."""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import Enum
from typing import TypeAlias
from urllib.parse import unquote, urlparse


class NativeSslMode(Enum):
    REQUIRE = "require"
    DISABLE = "disable"
    PREFER = "prefer"


SslMode: TypeAlias = NativeSslMode
SSL_MODES: tuple[str, ...] = tuple(mode.value for mode in NativeSslMode)


@dataclass(frozen=True, slots=True)
class ParsedAddress:
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
_PROJECT_ID = re.compile(r"^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$")
_HOSTNAME = re.compile(r"^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$", re.IGNORECASE)


def parse_resource_path(input: str | None) -> ParsedAddress:
    value = input.strip() if input else ""
    if not value.startswith("projects/"):
        return ParsedAddress()
    parts = value.split("/")
    if len(parts) < 2 or not parts[1]:
        return ParsedAddress()
    project = parts[1]
    if len(parts) == 2:
        return ParsedAddress(project=project)
    if len(parts) < 4 or parts[2] != "branches" or not parts[3]:
        return ParsedAddress()
    branch = parts[3]
    if len(parts) == 4:
        return ParsedAddress(project=project, branch=branch)
    if len(parts) != 6 or not parts[5]:
        return ParsedAddress()
    if parts[4] == "endpoints":
        return ParsedAddress(project=project, branch=branch, endpoint=value, endpoint_id=parts[5])
    if parts[4] == "databases":
        return ParsedAddress(project=project, branch=branch, database_resource_id=parts[5])
    return ParsedAddress()


def parse_address(input: str | None) -> ParsedAddress:
    value = input.strip() if input else ""
    if not value:
        return ParsedAddress()
    if re.match(r"^postgres(?:ql)?://", value, re.IGNORECASE):
        return _parse_uri(value)
    if value.startswith("projects/"):
        return parse_resource_path(value)
    if _HOSTNAME.fullmatch(value):
        return ParsedAddress(host=value)
    if _PROJECT_ID.fullmatch(value):
        return ParsedAddress(project=value)
    return ParsedAddress()


def _parse_uri(value: str) -> ParsedAddress:
    try:
        parsed = urlparse(value)
        port = parsed.port
    except ValueError:
        return ParsedAddress()
    target = unquote(parsed.path.removeprefix("/"))
    resource = parse_resource_path(target) if target.startswith("projects/") else ParsedAddress()
    query = dict(part.split("=", 1) for part in parsed.query.split("&") if "=" in part)
    ssl_value = unquote(query.get("sslmode", query.get("sslMode", ""))).lower()
    ssl_mode = next((mode for mode in NativeSslMode if mode.value == ssl_value), None)
    return ParsedAddress(
        project=resource.project,
        branch=resource.branch,
        endpoint=resource.endpoint,
        endpoint_id=resource.endpoint_id,
        database=None if resource.project else target or None,
        database_resource_id=resource.database_resource_id,
        user=unquote(parsed.username) if parsed.username else None,
        host=parsed.hostname,
        port=port,
        ssl_mode=ssl_mode,
    )


parseAddress = parse_address
parseResourcePath = parse_resource_path

__all__ = [
    "SSL_MODES",
    "LakebaseConnectionInputs",
    "NativeSslMode",
    "ParsedAddress",
    "SslMode",
    "parseAddress",
    "parseResourcePath",
    "parse_address",
    "parse_resource_path",
]
