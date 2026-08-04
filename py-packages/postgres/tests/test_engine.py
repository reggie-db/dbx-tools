from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from dbx_tools.postgres import (
    PostgresEngineConfig,
    ResolvedPostgresConnection,
    autoscaling_credential_provider,
    install_credential_injection,
    resolve_postgres_connection,
    workspace_credential_provider,
)
from sqlalchemy import create_engine


class FakeApiClient:
    def __init__(self, responses: dict[str, dict[str, Any]]) -> None:
        self.responses = responses
        self.requests: list[tuple[str, str, dict[str, Any]]] = []

    def do(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        self.requests.append((method, path, kwargs))
        return self.responses[path]


class FakeDatabase:
    def __init__(self) -> None:
        self.requests: list[tuple[str, ...]] = []

    def get_database_instance(self, name: str) -> Any:
        assert name == "app-db"
        return SimpleNamespace(read_write_dns="instance.example.com")

    def generate_database_credential(self, *, request_id: str, instance_names: list[str]) -> Any:
        assert request_id
        self.requests.append(tuple(instance_names))
        return SimpleNamespace(token=f"token-{len(self.requests)}")


def workspace(responses: dict[str, dict[str, Any]] | None = None) -> Any:
    return SimpleNamespace(
        api_client=FakeApiClient(responses or {}),
        config=SimpleNamespace(client_id=None),
        current_user=SimpleNamespace(me=lambda: SimpleNamespace(user_name="user@example.com")),
        database=FakeDatabase(),
    )


def test_resolve_provisioned_instance_with_workspace_client() -> None:
    client = workspace()
    resolved = resolve_postgres_connection(
        client,
        PostgresEngineConfig(instance_name="app-db", database="analytics"),
        environ={},
    )
    assert resolved.host == "instance.example.com"
    assert resolved.database == "analytics"
    assert resolved.user == "user@example.com"
    assert resolved.instance_name == "app-db"


def test_resolve_autoscaling_resource_path_with_workspace_client() -> None:
    client = workspace(
        {
            "/api/2.0/postgres/projects/demo/branches/main/endpoints/ep-1": {
                "name": "projects/demo/branches/main/endpoints/ep-1",
                "status": {"hosts": {"host": "ep-1.example.com"}},
            },
            "/api/2.0/postgres/projects/demo/branches/main/databases": {
                "databases": [
                    {
                        "name": "projects/demo/branches/main/databases/databricks-postgres",
                        "status": {"postgres_database": "databricks_postgres"},
                    }
                ]
            },
        }
    )
    resolved = resolve_postgres_connection(
        client,
        PostgresEngineConfig(
            address="projects/demo/branches/main/endpoints/ep-1",
            user="user@example.com",
        ),
        environ={},
    )
    assert resolved.host == "ep-1.example.com"
    assert resolved.database == "databricks_postgres"
    assert resolved.endpoint == "projects/demo/branches/main/endpoints/ep-1"


def test_workspace_credentials_are_injected_per_physical_connect() -> None:
    client = workspace()
    provider = workspace_credential_provider(client, "app-db")
    engine = create_engine("postgresql+psycopg://user@host/db")
    install_credential_injection(engine, provider)
    listeners = list(engine.dialect.dispatch.do_connect)
    first: dict[str, Any] = {}
    second: dict[str, Any] = {}
    listeners[0](None, None, [], first)
    listeners[0](None, None, [], second)
    assert first["password"] == "token-1"
    assert second["password"] == "token-2"


def test_asyncpg_url_uses_driver_ssl_parameter() -> None:
    resolved = ResolvedPostgresConnection(
        host="host.example.com",
        database="analytics",
        user="user@example.com",
    )

    assert resolved.url("postgresql+asyncpg").query == {"ssl": "require"}
    assert resolved.url("postgresql+psycopg").query == {"sslmode": "require"}


def test_autoscaling_credentials_are_injected_per_physical_connect() -> None:
    endpoint = "projects/demo/branches/main/endpoints/primary"
    client = workspace({"/api/2.0/postgres/credentials": {"token": "autoscaling-token"}})
    provider = autoscaling_credential_provider(client, endpoint)
    engine = create_engine("postgresql+psycopg://user@host/db")
    install_credential_injection(engine, provider)
    connection_parameters: dict[str, Any] = {}

    next(iter(engine.dialect.dispatch.do_connect))(None, None, [], connection_parameters)

    assert connection_parameters["password"] == "autoscaling-token"
    assert client.api_client.requests == [
        (
            "POST",
            "/api/2.0/postgres/credentials",
            {
                "headers": {
                    "Accept": "application/json",
                    "Content-Type": "application/json",
                },
                "body": {"endpoint": endpoint},
            },
        )
    ]
