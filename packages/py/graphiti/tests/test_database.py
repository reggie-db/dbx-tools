from pathlib import Path

import pytest
from dbx_tools.graphiti import database

"""Validate embedded PostgreSQL ownership and Lakebase credential injection."""


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

    runtime = await database._start_database({"databaseUrl": "project", "profile": "PROFILE"})
    password = runtime.connection_options["password"]

    assert callable(password)
    assert await password() == "token-3"
    assert await password() == "token-4"
    assert runtime.dsn == (
        "postgresql://user%40example.com@primary.example:5432/databricks_postgres?sslmode=require"
    )
    assert calls == [
        {"profile": "PROFILE"},
        {"project": "project"},
        "projects/project/branches/branch/endpoints/primary",
        "projects/project/branches/branch/endpoints/primary",
    ]


@pytest.mark.asyncio
async def test_local_postgres_url_is_used_without_lakebase(monkeypatch) -> None:
    monkeypatch.setattr(
        database,
        "create_lakebase_client",
        lambda *_: pytest.fail("Lakebase client should not be created"),
    )
    address = "postgresql://postgres@localhost:5433/graphiti"

    runtime = await database._start_database({"databaseUrl": address})

    assert runtime.dsn == address
    assert runtime.connection_options == {}
