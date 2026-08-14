from __future__ import annotations

import json
import os
import sys
from collections.abc import Callable, Mapping
from importlib import import_module
from pathlib import Path
from types import ModuleType
from typing import Any

from databricks.sdk import WorkspaceClient
from dbx_tools.postgres import create_async_engine
from graphiti_core.driver.neo4j_driver import Neo4jDriver
from sqlalchemy import make_url
from sqlalchemy.ext.asyncio import create_async_engine as sqlalchemy_create_async_engine

from .constants import PROCESS_STATE_PATH_ENV, UPSTREAM_MCP_PATH_ENV
from .persistence import DelegatingGraphDriver, PostgresWriteStorage

"""Pinned upstream MCP entry point with optional Postgres graph persistence."""

_PERSISTENCE_ENV = (
    "JOURNAL_DATABASE_URL",
    "LAKEBASE_ENDPOINT",
    "LAKEBASE_INSTANCE_NAME",
    "PGHOST",
)


def main() -> None:
    """Load the upstream MCP server and install persistence when configured."""
    _record_process_group(os.getpgid(0))
    try:
        graphiti_server = _load_upstream()
        if persistence_configured():
            graphiti_server.Graphiti = _persistent_graphiti_constructor(graphiti_server.Graphiti)
        graphiti_server.main()
    finally:
        _record_process_group(None)


def persistence_configured(environ: Mapping[str, str] | None = None) -> bool:
    """Return whether the environment selects a Postgres write journal."""
    env = os.environ if environ is None else environ
    return any(env.get(name, "").strip() for name in _PERSISTENCE_ENV)


def _record_process_group(process_group: int | None) -> None:
    """Record the sidecar group so an external `down` can reap descendants."""
    value = os.getenv(PROCESS_STATE_PATH_ENV)
    if not value:
        return
    path = Path(value)
    state = json.loads(path.read_text()) if path.exists() else {}
    if process_group is None:
        state.pop("graphiti_process_group", None)
    else:
        state["graphiti_process_group"] = process_group
    temporary = path.with_suffix(f".{os.getpid()}.tmp")
    temporary.write_text(json.dumps(state, indent=2) + "\n")
    temporary.chmod(0o600)
    temporary.replace(path)


def _load_upstream() -> ModuleType:
    """Import the pinned upstream MCP module from its cached source tree."""
    value = os.getenv(UPSTREAM_MCP_PATH_ENV)
    if not value:
        raise RuntimeError(f"{UPSTREAM_MCP_PATH_ENV} is required")
    source = Path(value) / "src"
    if not source.joinpath("graphiti_mcp_server.py").exists():
        raise RuntimeError(f"Graphiti MCP source is missing under {value}")
    sys.path.insert(0, str(source))
    return import_module("graphiti_mcp_server")


def _persistent_graphiti_constructor(graphiti_constructor: Callable[..., Any]):
    """Wrap each upstream Graphiti driver with Postgres persistence."""

    def create_graphiti(*args: Any, **kwargs: Any) -> Any:
        """Construct Graphiti with either its explicit or URI-derived driver."""
        graph_driver = kwargs.pop("graph_driver", None)
        if graph_driver is None:
            uri = kwargs.pop("uri", None)
            if uri is None:
                raise ValueError("uri must be provided when graph_driver is None")
            graph_driver = Neo4jDriver(
                uri,
                kwargs.pop("user", None),
                kwargs.pop("password", None),
            )
        storage = _postgres_storage()
        return graphiti_constructor(
            *args,
            graph_driver=DelegatingGraphDriver(graph_driver, storage),
            **kwargs,
        )

    return create_graphiti


def _postgres_storage() -> PostgresWriteStorage:
    """Create journal storage through a URL or dbx-tools Lakebase resolution."""
    database_url = os.getenv("JOURNAL_DATABASE_URL", "").strip()
    if database_url:
        url = make_url(database_url)
        if url.get_backend_name() != "postgresql":
            raise ValueError("JOURNAL_DATABASE_URL must use PostgreSQL")
        if url.drivername != "postgresql+asyncpg":
            url = url.set(drivername="postgresql+asyncpg")
        engine = sqlalchemy_create_async_engine(url, pool_pre_ping=True)
    else:
        engine = create_async_engine(WorkspaceClient(), pool_pre_ping=True)
    return PostgresWriteStorage(
        engine,
        namespace=os.getenv("JOURNAL_NAMESPACE", "default"),
        table=os.getenv("JOURNAL_TABLE", "graphiti_write_journal"),
        close_engine=True,
    )


if __name__ == "__main__":
    main()
