from __future__ import annotations

import datetime as dt
import os
import threading
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Protocol

from sqlalchemy import URL, Engine, event
from sqlalchemy import create_engine as sqlalchemy_create_engine
from sqlalchemy.ext.asyncio import AsyncEngine
from sqlalchemy.ext.asyncio import create_async_engine as sqlalchemy_create_async_engine

from .address import SSL_MODES, ParsedAddress, SslMode, parse_address, parse_resource_path

"""Lakebase connection resolution and connect-time credential injection."""

CredentialProvider = Callable[[], str]
CredentialLoader = Callable[[], tuple[str, dt.datetime | None]]

_API_BASE = "/api/2.0/postgres"
_CREDENTIAL_REFRESH_LEAD = dt.timedelta(minutes=5)
_DEFAULT_CREDENTIAL_LIFETIME = dt.timedelta(minutes=50)
_MINIMUM_CREDENTIAL_LIFETIME = dt.timedelta(minutes=1)
_DEFAULT_DATABASE = "databricks_postgres"
_DEFAULT_PORT = 5432
_DEFAULT_SSL_MODE: SslMode = "require"
_READ_WRITE_ENDPOINT_TYPE = "ENDPOINT_TYPE_READ_WRITE"


class WorkspaceApiClient(Protocol):
    def do(self, method: str, path: str, **kwargs: Any) -> Any: ...


class WorkspaceClientLike(Protocol):
    api_client: WorkspaceApiClient
    config: Any
    current_user: Any
    database: Any


@dataclass(frozen=True, slots=True)
class PostgresEngineConfig:
    address: str | None = None
    instance_name: str | None = None
    project: str | None = None
    branch: str | None = None
    endpoint: str | None = None
    database: str | None = None
    host: str | None = None
    port: int | None = None
    ssl_mode: SslMode | None = None
    user: str | None = None


@dataclass(frozen=True, slots=True)
class ResolvedPostgresConnection:
    host: str
    database: str
    user: str
    port: int = _DEFAULT_PORT
    ssl_mode: SslMode = _DEFAULT_SSL_MODE
    project: str | None = None
    branch: str | None = None
    endpoint: str | None = None
    instance_name: str | None = None

    def url(self, drivername: str) -> URL:
        ssl_parameter = "ssl" if drivername.endswith("+asyncpg") else "sslmode"
        return URL.create(
            drivername,
            username=self.user,
            password=None,
            host=self.host,
            port=self.port,
            database=self.database,
            query={ssl_parameter: self.ssl_mode},
        )


class _CachedCredentialProvider:
    """Cache one credential and serialize refreshes within the Python process."""

    def __init__(self, load: CredentialLoader) -> None:
        self._load = load
        self._lock = threading.RLock()
        self._token: str | None = None
        self._renew_at = dt.datetime.min.replace(tzinfo=dt.timezone.utc)

    def __call__(self) -> str:
        token = self._token
        if token is not None and _utcnow() < self._renew_at:
            return token
        with self._lock:
            if self._token is None or _utcnow() >= self._renew_at:
                token, expiration = self._load()
                self._token = token
                self._renew_at = _credential_renewal(expiration)
            assert self._token is not None
            return self._token


def workspace_credential_provider(
    workspace_client: WorkspaceClientLike,
    instance_name: str,
) -> CredentialProvider:
    if not instance_name.strip():
        raise ValueError("instance_name must not be empty")

    def load() -> tuple[str, dt.datetime | None]:
        credential = workspace_client.database.generate_database_credential(
            request_id=str(uuid.uuid4()),
            instance_names=[instance_name],
        )
        token = getattr(credential, "token", None)
        if not isinstance(token, str) or not token:
            raise RuntimeError("WorkspaceClient returned no Lakebase database credential token")
        return token, _credential_expiration(getattr(credential, "expiration_time", None))

    return _CachedCredentialProvider(load)


def autoscaling_credential_provider(
    workspace_client: WorkspaceClientLike,
    endpoint: str,
) -> CredentialProvider:
    if not endpoint.strip():
        raise ValueError("endpoint must not be empty")

    def load() -> tuple[str, dt.datetime | None]:
        credential = workspace_client.api_client.do(
            "POST",
            f"{_API_BASE}/credentials",
            headers={"Accept": "application/json", "Content-Type": "application/json"},
            body={"endpoint": endpoint},
        )
        token = credential.get("token") if isinstance(credential, dict) else None
        if not isinstance(token, str) or not token:
            raise RuntimeError("WorkspaceClient returned no Lakebase database credential token")
        return token, _mapping_credential_expiration(credential)

    return _CachedCredentialProvider(load)


def install_credential_injection(engine: Engine, provider: CredentialProvider) -> None:
    @event.listens_for(engine, "do_connect")
    def provide_token(
        dialect: Any,
        connection_record: Any,
        connection_arguments: list[Any],
        connection_parameters: dict[str, Any],
    ) -> None:
        del dialect, connection_record, connection_arguments
        connection_parameters["password"] = provider()


def create_engine(
    workspace_client: WorkspaceClientLike,
    config: PostgresEngineConfig | None = None,
    *,
    credential_provider: CredentialProvider | None = None,
    drivername: str = "postgresql+psycopg",
    **engine_options: Any,
) -> Engine:
    resolved = resolve_postgres_connection(workspace_client, config)
    engine = sqlalchemy_create_engine(resolved.url(drivername), **engine_options)
    provider = credential_provider or _default_provider(workspace_client, resolved)
    install_credential_injection(engine, provider)
    return engine


def create_async_engine(
    workspace_client: WorkspaceClientLike,
    config: PostgresEngineConfig | None = None,
    *,
    credential_provider: CredentialProvider | None = None,
    drivername: str = "postgresql+asyncpg",
    **engine_options: Any,
) -> AsyncEngine:
    resolved = resolve_postgres_connection(workspace_client, config)
    engine = sqlalchemy_create_async_engine(resolved.url(drivername), **engine_options)
    provider = credential_provider or _default_provider(workspace_client, resolved)
    install_credential_injection(engine.sync_engine, provider)
    return engine


def resolve_postgres_connection(
    workspace_client: WorkspaceClientLike,
    config: PostgresEngineConfig | None = None,
    *,
    environ: Mapping[str, str] | None = None,
) -> ResolvedPostgresConnection:
    config = config or PostgresEngineConfig()
    env = os.environ if environ is None else environ
    raw_address = _first(config.address, config.endpoint, env.get("LAKEBASE_ENDPOINT"))
    parsed = parse_address(raw_address)
    instance_name = _first(config.instance_name, env.get("LAKEBASE_INSTANCE_NAME"))
    project = _first(config.project, parsed.project)
    branch = _first(config.branch, parsed.branch)
    endpoint = _first(config.endpoint, env.get("LAKEBASE_ENDPOINT"), parsed.endpoint)
    host = _first(config.host, env.get("PGHOST"), parsed.host)
    database_value = _first(config.database, env.get("PGDATABASE"), parsed.database)
    database_path = parse_address(database_value)
    database_resource_id = parsed.database_resource_id or database_path.database_resource_id
    database = None if database_resource_id else database_value
    port = _parse_port(_first(config.port, env.get("PGPORT"), parsed.port))
    ssl_mode = _parse_ssl_mode(_first(config.ssl_mode, env.get("PGSSLMODE"), parsed.ssl_mode))
    user = _first(config.user, env.get("PGUSER"), parsed.user)

    if instance_name and not host:
        instance = workspace_client.database.get_database_instance(instance_name)
        host = getattr(instance, "read_write_dns", None)

    if not project and host and not instance_name:
        found = _find_endpoint_by_host(workspace_client, host)
        if found:
            project, branch, endpoint = found

    if not host and not instance_name:
        project = project or _pick_project(workspace_client)
        branch = branch or _pick_branch(workspace_client, project)
        if endpoint:
            endpoint_parts = parse_address(endpoint)
            if endpoint_parts.project and endpoint_parts.branch and endpoint_parts.endpoint_id:
                response = _get(
                    workspace_client,
                    f"{_API_BASE}/projects/{endpoint_parts.project}/branches/"
                    f"{endpoint_parts.branch}/endpoints/{endpoint_parts.endpoint_id}",
                )
                host = _endpoint_host(response)
        if not host:
            endpoint_record = _pick_endpoint(workspace_client, project, branch)
            endpoint = _string(endpoint_record.get("name"))
            host = _endpoint_host(endpoint_record)

    if not database and project and branch:
        database = _pick_database(workspace_client, project, branch, database_resource_id)
    database = database or _DEFAULT_DATABASE
    user = user or _workspace_user(workspace_client)

    if not host:
        raise ValueError("Could not resolve PGHOST from config, address, or WorkspaceClient")
    if not user:
        raise ValueError("Could not resolve PGUSER from config, address, or WorkspaceClient")
    return ResolvedPostgresConnection(
        host=host,
        database=database,
        user=user,
        port=port,
        ssl_mode=ssl_mode,
        project=project,
        branch=branch,
        endpoint=endpoint,
        instance_name=instance_name,
    )


def _credential_renewal(expiration: dt.datetime | None) -> dt.datetime:
    now = _utcnow()
    if expiration is None:
        return now + _DEFAULT_CREDENTIAL_LIFETIME
    normalized = (
        expiration.astimezone(dt.timezone.utc)
        if expiration.tzinfo is not None
        else expiration.replace(tzinfo=dt.timezone.utc)
    )
    return max(normalized - _CREDENTIAL_REFRESH_LEAD, now + _MINIMUM_CREDENTIAL_LIFETIME)


def _credential_expiration(value: object) -> dt.datetime | None:
    if isinstance(value, dt.datetime):
        return value
    if isinstance(value, (int, float)):
        try:
            return dt.datetime.fromtimestamp(value, tz=dt.timezone.utc)
        except (OSError, OverflowError, ValueError):
            return None
    if not isinstance(value, str) or not value.strip():
        return None
    normalized = value.strip().replace("Z", "+00:00")
    try:
        return dt.datetime.fromisoformat(normalized)
    except ValueError:
        return None


def _mapping_credential_expiration(credential: Mapping[str, object]) -> dt.datetime | None:
    for key in ("expiration_time", "expirationTime", "expires_at", "expiresAt"):
        expiration = _credential_expiration(credential.get(key))
        if expiration is not None:
            return expiration
    return None


def _utcnow() -> dt.datetime:
    return dt.datetime.now(tz=dt.timezone.utc)


def _default_provider(
    workspace_client: WorkspaceClientLike,
    resolved: ResolvedPostgresConnection,
) -> CredentialProvider:
    if resolved.instance_name:
        return workspace_credential_provider(workspace_client, resolved.instance_name)
    if resolved.endpoint:
        return autoscaling_credential_provider(workspace_client, resolved.endpoint)
    raise ValueError(
        "instance_name, endpoint, or credential_provider is required for connect-time credential injection"
    )


def _workspace_user(workspace_client: WorkspaceClientLike) -> str | None:
    current_user = workspace_client.current_user.me()
    return _first(
        getattr(current_user, "user_name", None),
        getattr(current_user, "userName", None),
        getattr(workspace_client.config, "client_id", None),
    )


def _get(workspace_client: WorkspaceClientLike, path: str) -> dict[str, Any]:
    value = workspace_client.api_client.do("GET", path, headers={"Accept": "application/json"})
    if not isinstance(value, dict):
        raise TypeError(f"WorkspaceClient returned a non-object response for {path}")
    return value


def _list(workspace_client: WorkspaceClientLike, path: str, key: str) -> list[dict[str, Any]]:
    values = _get(workspace_client, path).get(key, [])
    if not isinstance(values, list):
        raise TypeError(f"WorkspaceClient returned a non-list {key} response for {path}")
    return [value for value in values if isinstance(value, dict)]


def _pick_project(workspace_client: WorkspaceClientLike) -> str:
    projects = _list(workspace_client, f"{_API_BASE}/projects", "projects")
    candidates = [_resource_part(project.get("name"), "project") for project in projects]
    candidates = [candidate for candidate in candidates if candidate]
    if len(candidates) != 1:
        raise ValueError(f"Expected one Lakebase project, found: {', '.join(candidates) or 'none'}")
    return candidates[0]


def _pick_branch(workspace_client: WorkspaceClientLike, project: str) -> str:
    branches = _list(
        workspace_client,
        f"{_API_BASE}/projects/{project}/branches",
        "branches",
    )
    selected = next(
        (
            branch
            for branch in branches
            if isinstance(branch.get("status"), dict) and branch["status"].get("default") is True
        ),
        branches[0] if len(branches) == 1 else None,
    )
    branch = _resource_part(selected.get("name") if selected else None, "branch")
    if not branch:
        raise ValueError(f"Could not choose a Lakebase branch for project {project}")
    return branch


def _pick_endpoint(
    workspace_client: WorkspaceClientLike,
    project: str,
    branch: str,
) -> dict[str, Any]:
    endpoints = _list(
        workspace_client,
        f"{_API_BASE}/projects/{project}/branches/{branch}/endpoints",
        "endpoints",
    )
    selected = next(
        (
            endpoint
            for endpoint in endpoints
            if isinstance(endpoint.get("status"), dict)
            and endpoint["status"].get("endpoint_type") == _READ_WRITE_ENDPOINT_TYPE
        ),
        endpoints[0] if len(endpoints) == 1 else None,
    )
    if not selected:
        raise ValueError(f"Could not choose a Lakebase endpoint for {project}/{branch}")
    return selected


def _pick_database(
    workspace_client: WorkspaceClientLike,
    project: str,
    branch: str,
    resource_id: str | None,
) -> str:
    databases = _list(
        workspace_client,
        f"{_API_BASE}/projects/{project}/branches/{branch}/databases",
        "databases",
    )
    if resource_id:
        databases = [
            database
            for database in databases
            if _resource_part(database.get("name"), "database") == resource_id
        ]
    names = [
        _string(database.get("status", {}).get("postgres_database"))
        for database in databases
        if isinstance(database.get("status"), dict)
    ]
    names = [name for name in names if name]
    if _DEFAULT_DATABASE in names:
        return _DEFAULT_DATABASE
    if len(names) == 1:
        return names[0]
    raise ValueError(f"Could not choose a Lakebase database for {project}/{branch}")


def _find_endpoint_by_host(
    workspace_client: WorkspaceClientLike,
    host: str,
) -> tuple[str, str, str] | None:
    for project_record in _list(workspace_client, f"{_API_BASE}/projects", "projects"):
        project = _resource_part(project_record.get("name"), "project")
        if not project:
            continue
        for branch_record in _list(
            workspace_client,
            f"{_API_BASE}/projects/{project}/branches",
            "branches",
        ):
            branch = _resource_part(branch_record.get("name"), "branch")
            if not branch:
                continue
            for endpoint in _list(
                workspace_client,
                f"{_API_BASE}/projects/{project}/branches/{branch}/endpoints",
                "endpoints",
            ):
                if _endpoint_host(endpoint) == host and (name := _string(endpoint.get("name"))):
                    return project, branch, name
    return None


def _endpoint_host(endpoint: Mapping[str, Any]) -> str | None:
    status = endpoint.get("status")
    hosts = status.get("hosts") if isinstance(status, dict) else None
    return _string(hosts.get("host")) if isinstance(hosts, dict) else None


def _resource_part(value: object, kind: str) -> str | None:
    parsed: ParsedAddress = parse_resource_path(_string(value))
    return {
        "project": parsed.project,
        "branch": parsed.branch,
        "endpoint": parsed.endpoint_id,
        "database": parsed.database_resource_id,
    }[kind]


def _parse_port(value: object) -> int:
    if value is None or value == "":
        return _DEFAULT_PORT
    try:
        port = int(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"PGPORT must be a TCP port, got {value!r}") from error
    if not 1 <= port <= 65535:
        raise ValueError(f"PGPORT must be between 1 and 65535, got {port}")
    return port


def _parse_ssl_mode(value: object) -> SslMode:
    if value is None or value == "":
        return _DEFAULT_SSL_MODE
    mode = str(value).strip().lower()
    if mode not in SSL_MODES:
        raise ValueError(f"PGSSLMODE must be one of {', '.join(SSL_MODES)}, got {value!r}")
    return mode  # type: ignore[return-value]


def _first(*values: Any) -> Any:
    return next((value for value in values if value is not None and value != ""), None)


def _string(value: object) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


createEngine = create_engine
createAsyncEngine = create_async_engine
installCredentialInjection = install_credential_injection
resolvePostgresConnection = resolve_postgres_connection
workspaceCredentialProvider = workspace_credential_provider
autoscalingCredentialProvider = autoscaling_credential_provider
