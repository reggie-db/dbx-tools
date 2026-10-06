"""Run the pinned upstream MCP server with optional Postgres persistence."""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from importlib import import_module
from pathlib import Path
from tempfile import TemporaryDirectory
from types import ModuleType
from typing import Any

from databricks.sdk import WorkspaceClient
from dbx_tools.postgres._generated.node.auth.client import DatabricksAuthOptions
from dbx_tools.postgres.engine import create_async_engine, create_workspace_client
from graphiti_core.driver.neo4j_driver import Neo4jDriver
from sqlalchemy import make_url
from sqlalchemy.ext.asyncio import create_async_engine as sqlalchemy_create_async_engine

from .constants import UPSTREAM_MCP_PATH_ENV, persistence_configured
from .persistence import (
    DEFAULT_POSTGRES_JOURNAL_TABLE,
    DelegatingGraphDriver,
    PostgresWriteStorage,
)

def main() -> None:
    """Load the upstream MCP server and install persistence when configured."""
    profile = _take_profile_argument()
    workspace_client = (
        asyncio.run(_workspace_client(profile))
        if persistence_configured() and not os.getenv("JOURNAL_DATABASE_URL", "").strip()
        else None
    )
    graphiti_server = _load_upstream()
    if persistence_configured():
        graphiti_server.Graphiti = _persistent_graphiti_constructor(
            graphiti_server.Graphiti,
            workspace_client,
        )
    with _upstream_config():
        graphiti_server.main()


@contextmanager
def _upstream_config() -> Iterator[None]:
    """Supply an empty temporary YAML config unless the caller provided one."""
    if "--config" in sys.argv:
        yield
        return
    with TemporaryDirectory(prefix="dbx-graphiti-") as directory:
        path = Path(directory) / "config.yaml"
        path.write_text("{}\n")
        original_arguments = list(sys.argv)
        sys.argv[1:1] = ["--config", str(path)]
        try:
            yield
        finally:
            sys.argv[:] = original_arguments


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


def _persistent_graphiti_constructor(
    graphiti_constructor: Callable[..., Any],
    workspace_client: WorkspaceClient | None,
):
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
        storage = _postgres_storage(workspace_client)
        return graphiti_constructor(
            *args,
            graph_driver=DelegatingGraphDriver(graph_driver, storage),
            **kwargs,
        )

    return create_graphiti


def _postgres_storage(workspace_client: WorkspaceClient | None) -> PostgresWriteStorage:
    """Create journal storage through a URL or dbx-tools Lakebase resolution."""
    namespace = os.getenv("JOURNAL_NAMESPACE", "").strip()
    if not namespace:
        raise ValueError("JOURNAL_NAMESPACE is required when Postgres persistence is enabled")
    database_url = os.getenv("JOURNAL_DATABASE_URL", "").strip()
    if database_url:
        url = make_url(database_url)
        if url.get_backend_name() != "postgresql":
            raise ValueError("JOURNAL_DATABASE_URL must use PostgreSQL")
        if url.drivername != "postgresql+asyncpg":
            url = url.set(drivername="postgresql+asyncpg")
        engine = sqlalchemy_create_async_engine(url, pool_pre_ping=True)
    else:
        if workspace_client is None:
            raise RuntimeError("Databricks authentication is required for Lakebase persistence")
        engine = create_async_engine(workspace_client, pool_pre_ping=True)
    return PostgresWriteStorage(
        engine,
        namespace=namespace,
        table=os.getenv("JOURNAL_TABLE", DEFAULT_POSTGRES_JOURNAL_TABLE),
        close_engine=True,
    )


def _take_profile_argument() -> str | None:
    """Remove the wrapper profile option before invoking upstream Graphiti."""
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--profile")
    options, remaining = parser.parse_known_args(sys.argv[1:])
    sys.argv[1:] = remaining
    return options.profile


async def _workspace_client(profile: str | None) -> WorkspaceClient:
    """Construct the SDK client through the Node authentication package."""
    options = DatabricksAuthOptions(profile=profile) if profile is not None else None
    return await create_workspace_client(options)


if __name__ == "__main__":
    main()
