import builtins
from pathlib import Path

import pytest
from dbx_tools.graphiti import database

"""Validate embedded PostgreSQL ownership and Lakebase credential injection."""


async def _connect(calls, connection, dsn, options):
    calls.append(("connect", dsn, options))
    return connection


class _StaticLakebaseClient:
    """Return one stable Lakebase target and credential for ownership tests."""

    async def resolve(self, _target: object) -> dict[str, object]:
        return {
            "endpoint": "projects/project/branches/branch/endpoints/primary",
            "host": "primary.example",
            "port": 5432,
            "database": "databricks_postgres",
            "user": "app_login",
        }

    async def generate_database_credential(self, _endpoint: str) -> str:
        return "token"


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

    class Connection:
        async def execute(self, query: str) -> None:
            calls.append(query)

        async def fetchval(self, query: str, *_: object) -> str | None:
            calls.append(query)
            if query == "SELECT session_user":
                return "app_login"
            if query == database._SCHEMA_OWNER_QUERY:
                return next(owners)
            return "extensions"

        async def close(self) -> None:
            calls.append("closed")

    class Client:
        async def resolve(self, target):
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

        async def generate_database_credential(self, endpoint: str) -> str:
            calls.append(endpoint)
            return f"token-{len(calls)}"

    monkeypatch.setattr(database, "parse_address", lambda value: {"project": value})
    monkeypatch.setattr(
        database,
        "create_lakebase_client",
        lambda options=None: calls.append(options) or Client(),
    )
    monkeypatch.setattr(
        database.asyncpg,
        "connect",
        lambda dsn, **options: _connect(calls, Connection(), dsn, options),
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

    class Connection:
        async def fetchval(self, query: str, *_: object) -> str:
            calls.append(query)
            return "app_login"

        async def execute(self, query: str) -> None:
            calls.append(query)

        def transaction(self) -> Transaction:
            return Transaction()

        async def close(self) -> None:
            calls.append("closed")

    class Client:
        async def resolve(self, target):
            calls.append(target)
            return {
                "endpoint": "projects/project/branches/branch/endpoints/primary",
                "host": "primary.example",
                "port": 5432,
                "database": "databricks_postgres",
                "user": "app_login",
            }

        async def generate_database_credential(self, endpoint: str) -> str:
            calls.append(endpoint)
            return "token"

    monkeypatch.setattr(database, "parse_address", lambda value: {"project": value})
    monkeypatch.setattr(database, "create_lakebase_client", lambda: Client())
    monkeypatch.setattr(
        database.asyncpg,
        "connect",
        lambda dsn, **options: _connect(calls, Connection(), dsn, options),
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
    class Connection:
        async def fetchval(self, query: str, *_: object) -> str:
            return "app_login" if query == "SELECT session_user" else "another_owner"

        async def close(self) -> None:
            pass

    monkeypatch.setattr(database, "parse_address", lambda value: {"project": value})
    monkeypatch.setattr(database, "create_lakebase_client", _StaticLakebaseClient)
    monkeypatch.setattr(
        database.asyncpg,
        "connect",
        lambda dsn, **options: _connect([], Connection(), dsn, options),
    )

    with pytest.raises(RuntimeError, match="another_owner"):
        await database.prepare_lakebase_schema(
            "project",
            "graphiti_memory",
            "graphiti_owner",
        )


@pytest.mark.asyncio
async def test_prepare_lakebase_schema_requires_distinct_shared_role(monkeypatch) -> None:
    class Connection:
        async def fetchval(self, query: str, *_: object) -> str:
            return "app_login" if query == "SELECT session_user" else "another_owner"

        async def close(self) -> None:
            pass

    monkeypatch.setattr(database, "parse_address", lambda value: {"project": value})
    monkeypatch.setattr(database, "create_lakebase_client", _StaticLakebaseClient)
    monkeypatch.setattr(
        database.asyncpg,
        "connect",
        lambda dsn, **options: _connect([], Connection(), dsn, options),
    )

    with pytest.raises(RuntimeError, match="distinct shared role"):
        await database.prepare_lakebase_schema(
            "project",
            "graphiti_memory",
            "app_login",
        )


@pytest.mark.asyncio
async def test_prepare_lakebase_schema_allows_login_owned_noop(monkeypatch) -> None:
    class Connection:
        async def fetchval(self, _query: str, *_: object) -> str:
            return "app_login"

        async def close(self) -> None:
            pass

    monkeypatch.setattr(database, "parse_address", lambda value: {"project": value})
    monkeypatch.setattr(database, "create_lakebase_client", _StaticLakebaseClient)
    monkeypatch.setattr(
        database.asyncpg,
        "connect",
        lambda dsn, **options: _connect([], Connection(), dsn, options),
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

    class Connection:
        async def fetchval(self, query: str, *_: object) -> str:
            calls.append(query)
            return "app_login" if query == "SELECT session_user" else "another_owner"

        async def close(self) -> None:
            calls.append("closed")

    monkeypatch.setattr(database, "parse_address", lambda value: {"project": value})
    monkeypatch.setattr(database, "create_lakebase_client", _StaticLakebaseClient)
    monkeypatch.setattr(
        database.asyncpg,
        "connect",
        lambda dsn, **options: _connect([], Connection(), dsn, options),
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

    class Connection:
        async def fetchval(self, query: str):
            calls.append(query)
            return next(schemas)

        async def execute(self, query: str) -> None:
            calls.append(query)

    extension_schema = await database._ensure_vector_extension(
        Connection(),
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
