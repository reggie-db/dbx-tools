"""Command-line interface for the native Graphiti stack."""

from __future__ import annotations

import argparse
import json
import os
from collections.abc import Sequence

from .runtime import Runtime


def main(argv: Sequence[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        prog="dbx-graphiti",
        description="Run Graphiti MCP with a local native Neo4j backend (no containers).",
    )
    subparsers = parser.add_subparsers(dest="command")
    subparsers.add_parser("setup", help="Install pinned native prerequisites")
    start = subparsers.add_parser("start", help="Start Neo4j and Graphiti in the foreground")
    start.add_argument("graphiti_args", nargs=argparse.REMAINDER)
    up = subparsers.add_parser("up", help="Start Neo4j and Graphiti in the background")
    up.add_argument("graphiti_args", nargs=argparse.REMAINDER)
    subparsers.add_parser("down", help="Stop Graphiti and Neo4j")
    subparsers.add_parser("status", help="Show native process status")
    subparsers.add_parser("env", help="Print resolved connection settings")

    parsed = parser.parse_args(argv)
    runtime = Runtime()
    command = parsed.command or "start"
    if command == "setup":
        runtime.setup()
        print(f"Graphiti is ready under {runtime.paths.root}")
    elif command in {"start", "up"}:
        if not os.getenv("OPENAI_API_KEY"):
            parser.error("OPENAI_API_KEY is required by the default Graphiti configuration")
        extra_args = getattr(parsed, "graphiti_args", [])
        if extra_args[:1] == ["--"]:
            extra_args = extra_args[1:]
        result = runtime.start(foreground=command == "start", extra_args=extra_args)
        if command == "up":
            print(f"Graphiti started with PID {result}; MCP: http://127.0.0.1:8000/mcp/")
        elif result:
            raise SystemExit(result)
    elif command == "down":
        runtime.stop()
    elif command == "status":
        print(json.dumps(runtime.status(), indent=2))
    elif command == "env":
        state = runtime.read_state()
        print(json.dumps(runtime.connection_settings(str(state["neo4j_password"])), indent=2))
