"""Internal Python adapter for the Node-owned Graphiti runtime."""

from __future__ import annotations

import asyncio
import os
import sys

from . import server
from .settings import (
    load_graphiti_options,
    provider_environment,
    resolve_graphiti_models,
)


def main() -> None:
    """Resolve shared configuration and run the pinned upstream MCP server."""
    options = load_graphiti_options()
    options, _, _ = asyncio.run(resolve_graphiti_models(options))
    os.environ.update(provider_environment(options))
    sys.argv[1:1] = [
        "--host",
        options["graphitiHost"],
        "--port",
        str(int(options["graphitiPort"])),
        "--database-provider",
        "falkordb",
        "--llm-provider",
        "openai",
        "--model",
        options["model"],
        "--embedder-provider",
        "openai",
        "--embedder-model",
        options["embedderModel"],
    ]
    server.main()


__all__ = ["main"]
