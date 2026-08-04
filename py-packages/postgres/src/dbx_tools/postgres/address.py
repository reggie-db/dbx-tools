from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from typing import Literal
from urllib.parse import parse_qs, unquote, urlparse

SslMode = Literal["require", "disable", "prefer"]
SSL_MODES: tuple[SslMode, ...] = ("require", "disable", "prefer")

_URL_SCHEME_RE = re.compile(r"^(postgres|postgresql)://", re.IGNORECASE)
_PROJECT_ID_RE = re.compile(r"^[a-z][a-z0-9-]{0,61}[a-z0-9]$|^[a-z]$")
_HOSTNAME_HINT_RE = re.compile(r"^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$", re.IGNORECASE)


@dataclass(frozen=True, slots=True)
class LakebaseConnectionInputs:
    project: str | None = None
    branch: str | None = None
    endpoint: str | None = None
    database: str | None = None
    host: str | None = None
    port: int | None = None
    ssl_mode: SslMode | None = None

    def as_dict(self) -> dict[str, object]:
        return {key: value for key, value in asdict(self).items() if value is not None}


@dataclass(frozen=True, slots=True)
class ParsedAddress(LakebaseConnectionInputs):
    endpoint_id: str | None = None
    database_resource_id: str | None = None
    user: str | None = None


def parse_address(value: str | None) -> ParsedAddress:
    if not value or not (address := value.strip()):
        return ParsedAddress()
    if _URL_SCHEME_RE.match(address):
        return _parse_uri(address)
    if address.startswith("projects/"):
        return _parse_resource_path_segments(address)
    if "." in address and _HOSTNAME_HINT_RE.fullmatch(address):
        return ParsedAddress(host=address)
    if _PROJECT_ID_RE.fullmatch(address):
        return ParsedAddress(project=address)
    return ParsedAddress()


def parse_resource_path(value: str | None) -> ParsedAddress:
    if not value or not (address := value.strip()).startswith("projects/"):
        return ParsedAddress()
    return _parse_resource_path_segments(address)


def _parse_uri(address: str) -> ParsedAddress:
    try:
        parsed = urlparse(address)
        port = parsed.port
    except ValueError:
        return ParsedAddress()
    if parsed.scheme.lower() not in {"postgres", "postgresql"}:
        return ParsedAddress()
    ssl_mode_value = parse_qs(parsed.query).get("sslmode") or parse_qs(parsed.query).get("sslMode")
    ssl_mode = ssl_mode_value[0].lower() if ssl_mode_value else None
    return ParsedAddress(
        host=parsed.hostname or None,
        port=port,
        user=unquote(parsed.username) if parsed.username else None,
        database=unquote(parsed.path.removeprefix("/")) or None,
        ssl_mode=ssl_mode if ssl_mode in SSL_MODES else None,
    )


def _parse_resource_path_segments(address: str) -> ParsedAddress:
    parts = address.split("/")
    if len(parts) < 2 or parts[0] != "projects" or not parts[1]:
        return ParsedAddress()
    project = parts[1]
    if len(parts) == 2:
        return ParsedAddress(project=project)
    if len(parts) == 4 and parts[2] == "branches" and parts[3]:
        return ParsedAddress(project=project, branch=parts[3])
    if (
        len(parts) == 6
        and parts[2] == "branches"
        and parts[3]
        and parts[4] == "endpoints"
        and parts[5]
    ):
        return ParsedAddress(
            project=project,
            branch=parts[3],
            endpoint=address,
            endpoint_id=parts[5],
        )
    if (
        len(parts) == 6
        and parts[2] == "branches"
        and parts[3]
        and parts[4] == "databases"
        and parts[5]
    ):
        return ParsedAddress(
            project=project,
            branch=parts[3],
            database_resource_id=parts[5],
        )
    return ParsedAddress()


parseAddress = parse_address
parseResourcePath = parse_resource_path
