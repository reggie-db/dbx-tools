import builtins
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from dbx_tools.graphiti import database

"""Validate embedded PostgreSQL ownership and Lakebase credential injection."""


async def _connect(calls, connection, dsn, options):
    calls.append(("connect", dsn, options))
    return connection


def _static_lakebase_client() -> SimpleNamespace:
    return SimpleNamespace(
        resolve=AsyncMock(
            return_value={
                "endpoint": "projects/project/branches/branch/endpoints/primary",
                "host": "primary.example",
                "port": 5432,
                "database": "databricks_postgres",
                "user": "app_login",
            }
        ),
        generate_database_credential=AsyncMock(return_value="token"),
    )


def _credential_connection(calls: list[object], owners) -> SimpleNamespace:
    def fetchval(query: str, *_: object) -> str | None:
        calls.append(query)
        if query == "SELECT session_user":
            return "app_login"
        if query == database._SCHEMA_OWNER_QUERY:
            return next(owners)
        return "extensions"

    return SimpleNamespace(
        execute=AsyncMock(side_effect=calls.append),
        fetchval=AsyncMock(side_effect=fetchval),
        close=AsyncMock(side_effect=lambda: calls.append("closed")),
    )


def _credential_client(calls: list[object]) -> SimpleNamespace:
    def resolve(target: object) -> dict[str, object]:
        calls.append(target)
        return {
            "project": "project",
            "branch": "branch",
            "endpoint": "projects/project/branches/branch/endpoints/primary",
            "host": "primary.example",
            "port": 5432,
            "database": "databricks_postgres",
            "user": "user@example.com",
        }

    def credential(endpoint: str) -> str:
        calls.append(endpoint)
        return f"token-{len(calls)}"

    return SimpleNamespace(
        resolve=AsyncMock(side_effect=resolve),
        generate_database_credential=AsyncMock(side_effect=credential),
    )


def _schema_connection(
    schema_owner: str,
    calls: list[str] | None = None,
) -> SimpleNamespace:
    def fetchval(query: str, *_: object) -> str:
        if calls is not None:
            calls.append(query)
        return "app_login" if query == "SELECT session_user" else schema_owner

    def close() -> None:
        if calls is not None:
            calls.append("closed")

    return SimpleNamespace(
        fetchval=AsyncMock(side_effect=fetchval),
        close=AsyncMock(side_effect=close),
    )


@pytest.mark.asyncio
async def test_missing_database_starts_persistent_embedded_postgres(
    monkeypatch,
    tmp_path: Path,
) -> None:
    events: list[object] = []

    class Server:
        def psql(self, command: str) -> None:
            events.append(command)

        def get_uri(self, name: str) -> str:
            events.append(name)
            return "postgresql://postgres:@/postgres?host=/socket"

        def __exit__(self, *_: object) -> None:
            events.append("closed")

    server = Server()

    def open_server(path: Path):
        events.append(path)
        return server

    monkeypatch.setattr(database, "_open_embedded_server", open_server)

    runtime = await database._start_database({"graphitiHome": str(tmp_path)})
    assert runtime.dsn == "postgresql://postgres:@/postgres?host=/socket"
    assert events == [
        tmp_path / "postgres",
        "CREATE EXTENSION IF NOT EXISTS vector",
        "postgres",
    ]

    await runtime.close()
    assert events[-1] == "closed"


@pytest.mark.asyncio
async def test_lakebase_credentials_are_minted_for_each_connection(monkeypatch) -> None:
    calls: list[object] = []
    owners = iter([None, "graphiti_owner"])
    connection = _credential_connection(calls, owners)
    client = _credential_client(calls)

    monkeypatch.setattr(database, "parse_address", lambda value: {"project": value})
    monkeypatch.setattr(
        database,
        "create_lakebase_client",
        lambda options=None: calls.append(options) or client,
    )
    monkeypatch.setattr(
        database.asyncpg,
        "connect",
        lambda dsn, **options: _connect(calls, connection, dsn, options),
    )

    runtime = await database._start_database(
        {
            "postgresRole": "graphiti_owner",
            "databaseUrl": "project",
            "databaseSchema": "graphiti_memory",
            "profile": "PROFILE",
        }
    )
    password = runtime.connection_options["password"]

    assert callable(password)
    assert await password() == "token-12"
    assert await password() == "token-13"
    assert runtime.connection_options["server_settings"] == {
        "search_path": "graphiti_memory, extensions, public",
        "role": "graphiti_owner",
    }
    assert runtime.dsn == (
        "postgresql://user%40example.com@primary.example:5432/databricks_postgres?sslmode=require"
    )
    assert calls == [
        {"profile": "PROFILE"},
        {"project": "project"},
        "projects/project/branches/branch/endpoints/primary",
        (
            "connect",
            "postgresql://user%40example.com@primary.example:5432/databricks_postgres?sslmode=require",
            {"password": "token-3"},
        ),
        "SELECT session_user",
        database._SCHEMA_OWNER_QUERY,
        'CREATE SCHEMA IF NOT EXISTS "graphiti_memory" AUTHORIZATION "graphiti_owner"',
        database._SCHEMA_OWNER_QUERY,
        'SET ROLE "graphiti_owner"',
        (
            "SELECT quote_ident(n.nspname) FROM pg_extension e "
            "JOIN pg_namespace n ON n.oid = e.extnamespace "
            "WHERE e.extname = 'vector'"
        ),
        "closed",
        "projects/project/branches/branch/endpoints/primary",
        "projects/project/branches/branch/endpoints/primary",
    ]


@pytest.mark.asyncio
async def test_prepare_lakebase_schema_recreates_current_users_schema(monkeypatch) -> None:
    calls: list[object] = []

    class Transaction:
        async def __aenter__(self) -> None:
            calls.append("begin")

        async def __aexit__(self, *_: object) -> None:
            calls.append("commit")

    def fetchval(query: str, *_: object) -> str:
        calls.append(query)
        return "app_login"

    connection = SimpleNamespace(
        fetchval=AsyncMock(side_effect=fetchval),
        execute=AsyncMock(side_effect=calls.append),
        transaction=Transaction,
        close=AsyncMock(side_effect=lambda: calls.append("closed")),
    )

    def resolve(target: object) -> dict[str, object]:
        calls.append(target)
        return {
            "endpoint": "projects/project/branches/branch/endpoints/primary",
            "host": "primary.example",
            "port": 5432,
            "database": "databricks_postgres",
            "user": "app_login",
        }

    client = SimpleNamespace(
        resolve=AsyncMock(side_effect=resolve),
        generate_database_credential=AsyncMock(
            side_effect=lambda endpoint: calls.append(endpoint) or "token"
        ),
    )

    monkeypatch.setattr(database, "parse_address", lambda value: {"project": value})
    monkeypatch.setattr(database, "create_lakebase_client", lambda: client)
    monkeypatch.setattr(
        database.asyncpg,
        "connect",
        lambda dsn, **options: _connect(calls, connection, dsn, options),
    )

    recreated = await database.prepare_lakebase_schema(
        "project",
        "graphiti_memory",
        "graphiti_owner",
    )

    assert recreated is True
    assert 'DROP SCHEMA IF EXISTS "graphiti_memory" CASCADE' in calls
    assert 'CREATE SCHEMA "graphiti_memory" AUTHORIZATION "graphiti_owner"' in calls
    assert calls[-1] == "closed"


@pytest.mark.asyncio
async def test_prepare_lakebase_schema_rejects_another_owner(monkeypatch) -> None:
    monkeypatch.setattr(database, "parse_address", lambda value: {"project": value})
    monkeypatch.setattr(database, "create_lakebase_client", _static_lakebase_client)
    monkeypatch.setattr(
        database.asyncpg,
        "connect",
        lambda dsn, **options: _connect([], _schema_connection("another_owner"), dsn, options),
    )

    with pytest.raises(RuntimeError, match="another_owner"):
        await database.prepare_lakebase_schema(
            "project",
            "graphiti_memory",
            "graphiti_owner",
        )


@pytest.mark.asyncio
async def test_prepare_lakebase_schema_requires_distinct_shared_role(monkeypatch) -> None:
    monkeypatch.setattr(database, "parse_address", lambda value: {"project": value})
    monkeypatch.setattr(database, "create_lakebase_client", _static_lakebase_client)
    monkeypatch.setattr(
        database.asyncpg,
        "connect",
        lambda dsn, **options: _connect([], _schema_connection("another_owner"), dsn, options),
    )

    with pytest.raises(RuntimeError, match="distinct shared role"):
        await database.prepare_lakebase_schema(
            "project",
            "graphiti_memory",
            "app_login",
        )


@pytest.mark.asyncio
async def test_prepare_lakebase_schema_allows_login_owned_noop(monkeypatch) -> None:
    monkeypatch.setattr(database, "parse_address", lambda value: {"project": value})
    monkeypatch.setattr(database, "create_lakebase_client", _static_lakebase_client)
    monkeypatch.setattr(
        database.asyncpg,
        "connect",
        lambda dsn, **options: _connect([], _schema_connection("app_login"), dsn, options),
    )

    recreated = await database.prepare_lakebase_schema(
        "project",
        "graphiti_memory",
        "app_login",
    )

    assert recreated is False


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("role", "message"),
    [
        (None, "no distinct shared role"),
        ("graphiti_owner", "configured shared role"),
    ],
)
async def test_lakebase_schema_rejects_mismatched_owner(
    monkeypatch,
    role: str | None,
    message: str,
) -> None:
    calls: list[str] = []

    monkeypatch.setattr(database, "parse_address", lambda value: {"project": value})
    monkeypatch.setattr(database, "create_lakebase_client", _static_lakebase_client)
    monkeypatch.setattr(
        database.asyncpg,
        "connect",
        lambda dsn, **options: _connect(
            [],
            _schema_connection("another_owner", calls),
            dsn,
            options,
        ),
    )

    with pytest.raises(RuntimeError, match=message):
        await database._start_lakebase_database(
            "project",
            None,
            "graphiti_memory",
            role,
        )

    assert calls == ["SELECT session_user", database._SCHEMA_OWNER_QUERY, "closed"]


@pytest.mark.asyncio
async def test_missing_vector_extension_is_installed_in_graphiti_schema() -> None:
    calls: list[str] = []
    schemas = iter([None, "graphiti_memory"])
    connection = SimpleNamespace(
        fetchval=AsyncMock(side_effect=lambda query: calls.append(query) or next(schemas)),
        execute=AsyncMock(side_effect=calls.append),
    )

    extension_schema = await database._ensure_vector_extension(
        connection,
        "graphiti_memory",
    )

    assert extension_schema == "graphiti_memory"
    assert calls == [
        (
            "SELECT quote_ident(n.nspname) FROM pg_extension e "
            "JOIN pg_namespace n ON n.oid = e.extnamespace "
            "WHERE e.extname = 'vector'"
        ),
        'CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA "graphiti_memory"',
        (
            "SELECT quote_ident(n.nspname) FROM pg_extension e "
            "JOIN pg_namespace n ON n.oid = e.extnamespace "
            "WHERE e.extname = 'vector'"
        ),
    ]


@pytest.mark.asyncio
async def test_local_postgres_url_is_used_without_lakebase(monkeypatch) -> None:
    monkeypatch.setattr(
        database,
        "create_lakebase_client",
        lambda *_: pytest.fail("Lakebase client should not be created"),
    )
    address = "postgresql://postgres@localhost:5433/graphiti"

    runtime = await database._start_database(
        {"databaseUrl": address, "postgresRole": "graphiti_owner"}
    )

    assert runtime.dsn == address
    assert runtime.connection_options == {"server_settings": {"role": "graphiti_owner"}}


def test_embedded_mode_names_the_optional_extra_when_missing(monkeypatch, tmp_path: Path) -> None:
    original_import = builtins.__import__

    def missing_embedded(name, *args, **kwargs):
        if name == "embedded_postgres":
            raise ImportError("missing embedded runtime")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", missing_embedded)

    with pytest.raises(RuntimeError, match=r"dbx-tools-graphiti\[dev\]"):
        database._open_embedded_server(tmp_path / "postgres")
