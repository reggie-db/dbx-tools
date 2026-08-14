from __future__ import annotations

import argparse
import json
from collections.abc import Sequence

from .runtime import Runtime
from .settings import ModelSettings

"""Command-line interface for the native Graphiti stack."""


def main(argv: Sequence[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        prog="dbx-graphiti",
        description="Run Graphiti MCP with a local native Neo4j backend (no containers).",
    )
    subparsers = parser.add_subparsers(dest="command")
    subparsers.add_parser("setup", help="Install pinned native prerequisites")
    start = subparsers.add_parser("start", help="Start Neo4j, LiteLLM, and Graphiti")
    _add_model_options(start)
    start.add_argument("graphiti_args", nargs=argparse.REMAINDER)
    up = subparsers.add_parser("up", help="Start Neo4j, LiteLLM, and Graphiti in the background")
    _add_model_options(up)
    up.add_argument("graphiti_args", nargs=argparse.REMAINDER)
    subparsers.add_parser("down", help="Stop Graphiti, LiteLLM, and Neo4j")
    subparsers.add_parser("status", help="Show native process status")
    environment = subparsers.add_parser("env", help="Print resolved runtime settings")
    _add_model_options(environment)

    parsed = parser.parse_args(argv)
    runtime = Runtime()
    command = parsed.command or "start"
    if command == "setup":
        runtime.setup()
        print(f"Graphiti is ready under {runtime.paths.root}")
    elif command in {"start", "up"}:
        extra_args = getattr(parsed, "graphiti_args", [])
        if extra_args[:1] == ["--"]:
            extra_args = extra_args[1:]
        result = runtime.start(
            foreground=command == "start",
            extra_args=extra_args,
            settings=_model_settings(parsed),
        )
        if command == "up":
            print(json.dumps({"graphiti_pid": result, **runtime.status()}, indent=2))
        elif result:
            raise SystemExit(result)
    elif command == "down":
        runtime.stop()
    elif command == "status":
        print(json.dumps(runtime.status(), indent=2))
    elif command == "env":
        state = runtime.read_state()
        print(
            json.dumps(
                runtime.connection_settings(
                    str(state["neo4j_password"]),
                    _model_settings(parsed),
                ),
                indent=2,
            )
        )


def _add_model_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--profile",
        help=(
            "Optional Databricks profile override; otherwise uses "
            "DATABRICKS_CONFIG_PROFILE, then the Databricks CLI default"
        ),
    )
    parser.add_argument("--model", help="Graphiti LLM model")
    parser.add_argument("--embedder-model", help="Graphiti embedding model")
    parser.add_argument("--embedder-dimensions", type=int, help="Embedding vector dimensions")
    parser.add_argument("--litellm-url", help="External LiteLLM OpenAI-compatible base URL")
    parser.add_argument("--litellm-host", help="Managed LiteLLM listen host")
    parser.add_argument("--litellm-port", type=int, help="Managed LiteLLM listen port")
    ownership = parser.add_mutually_exclusive_group()
    ownership.add_argument(
        "--manage-litellm",
        action="store_true",
        default=None,
        help="Start and stop the bundled LiteLLM proxy",
    )
    ownership.add_argument(
        "--no-manage-litellm",
        action="store_false",
        dest="manage_litellm",
        help="Use the configured external OpenAI-compatible endpoint",
    )


def _model_settings(args: argparse.Namespace) -> ModelSettings:
    return ModelSettings.resolve(
        profile=getattr(args, "profile", None),
        model=getattr(args, "model", None),
        embedder_model=getattr(args, "embedder_model", None),
        embedder_dimensions=getattr(args, "embedder_dimensions", None),
        litellm_url=getattr(args, "litellm_url", None),
        litellm_host=getattr(args, "litellm_host", None),
        litellm_port=getattr(args, "litellm_port", None),
        manage_litellm=getattr(args, "manage_litellm", None),
    )
