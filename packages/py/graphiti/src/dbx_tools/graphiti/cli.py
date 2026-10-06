"""Internal dispatcher for the Commander-owned Graphiti CLI."""

from __future__ import annotations

import asyncio
import json
import os

from .runtime import Runtime, RuntimePaths
from .settings import (
    GRAPHITI_COMMAND_ENV,
    load_graphiti_options,
    resolve_graphiti_models,
)


def main() -> None:
    """Execute the operation and serialized config supplied by the JavaScript CLI."""
    command = os.getenv(GRAPHITI_COMMAND_ENV, "start").strip() or "start"
    options = load_graphiti_options()
    runtime = Runtime(RuntimePaths.from_options(options))
    if command in {"start", "up", "env"}:
        options, model_route, embedder_route = asyncio.run(resolve_graphiti_models(options))
    else:
        model_route = None
        embedder_route = None
    if command == "start":
        result = runtime.start(settings=options)
        if result:
            raise SystemExit(result)
        return
    if command == "up":
        process_id = runtime.start(foreground=False, settings=options)
        print(json.dumps({"graphiti_pid": process_id, **runtime.status()}, indent=2))
        return
    if command == "down":
        runtime.stop()
        return
    if command == "status":
        print(json.dumps(runtime.status(), indent=2))
        return
    if command == "env":
        state = runtime.read_state()
        print(
            json.dumps(
                runtime.connection_settings(
                    str(state["neo4j_password"]),
                    options,
                    model_route,
                    embedder_route,
                ),
                indent=2,
            )
        )
        return
    raise ValueError(f"Unsupported Graphiti command: {command}")
