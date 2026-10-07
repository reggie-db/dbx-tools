from __future__ import annotations

import asyncio
import ipaddress
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlencode, urlsplit

import embedded_postgres
from platformdirs import user_data_path

from ._generated.node.lakebase.bindings import (
    LakebaseClient,
    ResolvedLakebaseResponse,
    create_lakebase_client,
    parse_address,
)
from .options import ResolvedGraphitiOptionsResponse

"""Resolve external Lakebase targets or own persistent embedded PostgreSQL."""

_DATABASE_DIRECTORY = "postgres"
_DEFAULT_DATABASE = "postgres"
_LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})


@dataclass
class _DatabaseRuntime:
    """Connection inputs and lifecycle state for one Graphiti database."""

    dsn: str
    connection_options: dict[str, Any] = field(default_factory=dict)
    _embedded: embedded_postgres.PostgresServer | None = None
    _lakebase: LakebaseClient | None = None

    async def close(self) -> None:
        """Stop an owned embedded server while preserving its data directory."""
        if self._embedded is None:
            return
        server = self._embedded
        self._embedded = None
        await asyncio.to_thread(server.__exit__, None, None, None)


async def _start_database(
    options: ResolvedGraphitiOptionsResponse,
) -> _DatabaseRuntime:
    """Resolve the configured database or start persistent embedded PostgreSQL."""
    address = options.get("databaseUrl")
    if not address:
        return await _start_embedded_database(options.get("graphitiHome"))
    if not _uses_lakebase_credentials(address):
        return _DatabaseRuntime(dsn=address)
    return await _start_lakebase_database(address, options.get("profile"))


async def _start_embedded_database(home: str | None) -> _DatabaseRuntime:
    """Start the bundled PostgreSQL distribution under the Graphiti data directory."""
    root = (
        Path(home).expanduser().resolve()
        if home
        else user_data_path("dbx-tools", appauthor=False) / "graphiti"
    )
    root.mkdir(parents=True, exist_ok=True)
    server = await asyncio.to_thread(_open_embedded_server, root / _DATABASE_DIRECTORY)
    try:
        await asyncio.to_thread(server.psql, "CREATE EXTENSION IF NOT EXISTS vector")
    except BaseException:
        await asyncio.to_thread(server.__exit__, None, None, None)
        raise
    return _DatabaseRuntime(
        dsn=server.get_uri(_DEFAULT_DATABASE),
        _embedded=server,
    )


async def _start_lakebase_database(
    address: str,
    profile: str | None,
) -> _DatabaseRuntime:
    """Resolve Lakebase coordinates and mint a credential for each new pool connection."""
    client = create_lakebase_client({"profile": profile}) if profile else create_lakebase_client()
    resolved = await client.resolve(parse_address(address))

    async def password() -> str:
        return await client.generate_database_credential(resolved["endpoint"])

    return _DatabaseRuntime(
        dsn=_lakebase_dsn(resolved),
        connection_options={"password": password},
        _lakebase=client,
    )


def _open_embedded_server(path: Path) -> embedded_postgres.PostgresServer:
    """Open a counted embedded PostgreSQL handle for deterministic cleanup."""
    return embedded_postgres.get_server(path, cleanup_mode="stop").__enter__()


def _uses_lakebase_credentials(address: str) -> bool:
    """Identify passwordless non-local targets that require Lakebase discovery."""
    parsed = urlsplit(address)
    if parsed.scheme not in {"postgres", "postgresql"}:
        return True
    if parsed.password is not None or parsed.hostname is None:
        return False
    try:
        local = ipaddress.ip_address(parsed.hostname).is_loopback
    except ValueError:
        local = parsed.hostname.lower() in _LOCAL_HOSTS
    return not local


def _lakebase_dsn(resolved: ResolvedLakebaseResponse) -> str:
    """Build an asyncpg DSN without persisting the short-lived credential."""
    host = resolved["host"]
    formatted_host = f"[{host}]" if ":" in host and not host.startswith("[") else host
    user = quote(resolved["user"], safe="")
    database = quote(resolved["database"], safe="")
    query = urlencode({"sslmode": "require"})
    return f"postgresql://{user}@{formatted_host}:{int(resolved['port'])}/{database}?{query}"
