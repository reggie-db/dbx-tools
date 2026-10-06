"""Run the pinned upstream MCP server against Node-owned FalkorDB."""

from __future__ import annotations

import os
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from importlib import import_module
from pathlib import Path
from tempfile import TemporaryDirectory
from types import ModuleType

from .constants import FALKORDB_SOCKET_PATH_ENV

UPSTREAM_SOURCE_DIR = Path(__file__).with_name("_upstream")


def main() -> None:
    """Patch the Falkor driver to the private socket and run upstream Graphiti."""
    _install_socket_driver()
    graphiti_server = _load_upstream()
    with _upstream_config():
        graphiti_server.main()


def _install_socket_driver() -> None:
    """Make upstream Falkor construction use the Node-owned Unix socket."""
    socket_path = os.getenv(FALKORDB_SOCKET_PATH_ENV, "").strip()
    if not socket_path:
        raise RuntimeError(f"{FALKORDB_SOCKET_PATH_ENV} is required")

    from falkordb.asyncio import FalkorDB
    from graphiti_core.driver import falkordb_driver

    driver_type = falkordb_driver.FalkorDriver

    class SocketFalkorDriver(driver_type):
        """Falkor driver connected through the private embedded socket."""

        def __init__(
            self,
            host: str = "localhost",
            port: int = 6379,
            username: str | None = None,
            password: str | None = None,
            falkor_db: FalkorDB | None = None,
            database: str = "default_db",
        ) -> None:
            del host, port, username, password, falkor_db
            super().__init__(
                falkor_db=FalkorDB(unix_socket_path=socket_path),
                database=database,
            )

    falkordb_driver.FalkorDriver = SocketFalkorDriver


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
    """Import the pinned upstream MCP module bundled with this package."""
    source = UPSTREAM_SOURCE_DIR
    if not source.joinpath("graphiti_mcp_server.py").exists():
        raise RuntimeError(f"Bundled Graphiti MCP source is missing under {source}")
    source_path = str(source)
    if source_path not in sys.path:
        sys.path.insert(0, source_path)
    module = import_module("graphiti_mcp_server")
    module_path = Path(module.__file__ or "").resolve()
    if not module_path.is_relative_to(source.resolve()):
        raise RuntimeError(f"Graphiti MCP resolved outside bundled source: {module_path}")
    return module


if __name__ == "__main__":
    main()
