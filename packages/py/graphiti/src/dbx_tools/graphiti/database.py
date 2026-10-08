"""Resolve external Lakebase targets or own persistent embedded PostgreSQL."""

from __future__ import annotations

import asyncio
import ipaddress
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any
from urllib.parse import quote, urlencode, urlsplit

import asyncpg
from platformdirs import user_data_path

if TYPE_CHECKING:
    import embedded_postgres

from ._generated.node.lakebase.bindings import (
    LakebaseClient,
    ResolvedLakebaseResponse,
    create_lakebase_client,
    parse_address,
)
from ._generated.node.postgres.bindings import (
    postgres_role_statement,
    postgres_server_settings,
    quote_postgres_identifier,
    resolve_postgres_role,
)
from .options import ResolvedGraphitiOptionsResponse

_DATABASE_DIRECTORY = "postgres"
_EMBEDDED_DATABASE = "postgres"
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
    role = resolve_postgres_role(options.get("postgresRole"))
    if not address:
        return await _start_embedded_database(options.get("graphitiHome"), role)
    if not _uses_lakebase_credentials(address):
        return _DatabaseRuntime(
            dsn=address,
            connection_options=_database_role_options(role),
        )
    return await _start_lakebase_database(
        address,
        options.get("profile"),
        options["databaseSchema"],
        role,
    )


async def _start_embedded_database(
    home: str | None,
    role: str | None = None,
) -> _DatabaseRuntime:
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
        dsn=server.get_uri(_EMBEDDED_DATABASE),
        connection_options=_database_role_options(role),
        _embedded=server,
    )


async def _start_lakebase_database(
    address: str,
    profile: str | None,
    schema: str,
    role: str | None = None,
) -> _DatabaseRuntime:
    """Resolve Lakebase coordinates and mint a credential for each new pool connection."""
    client = create_lakebase_client({"profile": profile}) if profile else create_lakebase_client()
    resolved = await client.resolve(parse_address(address))

    async def password() -> str:
        return await client.generate_database_credential(resolved["endpoint"])

    dsn = _lakebase_dsn(resolved)
    connection = await asyncpg.connect(dsn, password=await password())
    try:
        authorization = f" AUTHORIZATION {quote_postgres_identifier(role)}" if role else ""
        await connection.execute(f'CREATE SCHEMA IF NOT EXISTS "{schema}"{authorization}')
        role_statement = postgres_role_statement(role)
        if role_statement:
            await connection.execute(role_statement)
        extension_schema = await _ensure_vector_extension(connection, schema)
    finally:
        await connection.close()

    search_path = [schema]
    if extension_schema != schema:
        search_path.append(extension_schema)
    search_path.append("public")
    server_settings = postgres_server_settings(
        role,
        {"search_path": ", ".join(search_path)},
    )
    return _DatabaseRuntime(
        dsn=dsn,
        connection_options={
            "password": password,
            "server_settings": server_settings,
        },
        _lakebase=client,
    )


def _database_role_options(role: str | None) -> dict[str, Any]:
    """Return asyncpg/PostGraph connection options for an assumed database role."""
    server_settings = postgres_server_settings(role)
    return {"server_settings": server_settings} if server_settings else {}


async def _ensure_vector_extension(connection: asyncpg.Connection, schema: str) -> str:
    """Install vector in the Graphiti schema or locate its database-wide installation."""
    query = (
        "SELECT quote_ident(n.nspname) FROM pg_extension e "
        "JOIN pg_namespace n ON n.oid = e.extnamespace "
        "WHERE e.extname = 'vector'"
    )
    extension_schema = await connection.fetchval(query)
    if extension_schema is None:
        await connection.execute(f'CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA "{schema}"')
        extension_schema = await connection.fetchval(query)
    if extension_schema is None:
        raise RuntimeError("PostgreSQL vector extension installation did not complete")
    return extension_schema


def _open_embedded_server(path: Path) -> embedded_postgres.PostgresServer:
    """Open a counted embedded PostgreSQL handle for deterministic cleanup."""
    try:
        import embedded_postgres
    except ImportError as error:
        raise RuntimeError(
            "Embedded Graphiti storage requires dbx-tools-graphiti[dev]; "
            "configure databaseUrl for Lakebase or external PostgreSQL instead"
        ) from error
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
