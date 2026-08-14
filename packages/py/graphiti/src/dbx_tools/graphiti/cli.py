from __future__ import annotations

import json
import sys
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Annotated

from cyclopts import App, Parameter

from .runtime import Runtime
from .settings import ModelSettings

"""Command-line interface for the native Graphiti stack."""

_APP = App(
    name="dbx-graphiti",
    help="Run Graphiti MCP with a local native Neo4j backend (no containers).",
)


@dataclass
class ModelOptions:
    """Model, profile, and managed LiteLLM settings shared by commands."""

    profile: Annotated[
        str | None,
        Parameter(name="--profile", env_var="DATABRICKS_CONFIG_PROFILE"),
    ] = None
    model: Annotated[str | None, Parameter(name="--model", env_var="MODEL_NAME")] = None
    embedder_model: Annotated[
        str | None,
        Parameter(name="--embedder-model", env_var="EMBEDDER_MODEL"),
    ] = None
    embedder_dimensions: Annotated[
        int | None,
        Parameter(name="--embedder-dimensions", env_var="EMBEDDER_DIMENSIONS"),
    ] = None
    litellm_url: Annotated[
        str | None,
        Parameter(name="--litellm-url", env_var="LITELLM_URL"),
    ] = None
    litellm_host: Annotated[
        str | None,
        Parameter(name="--litellm-host", env_var="LITELLM_HOST"),
    ] = None
    litellm_port: Annotated[
        int | None,
        Parameter(name="--litellm-port", env_var="LITELLM_PORT"),
    ] = None
    manage_litellm: Annotated[
        bool | None,
        Parameter(
            name="--manage-litellm",
            env_var="MANAGE_LITELLM",
            negative="--no-manage-litellm",
        ),
    ] = None

    def settings(self) -> ModelSettings:
        """Resolve CLI and environment values into runtime settings."""
        return ModelSettings.resolve(
            profile=self.profile,
            model=self.model,
            embedder_model=self.embedder_model,
            embedder_dimensions=self.embedder_dimensions,
            litellm_url=self.litellm_url,
            litellm_host=self.litellm_host,
            litellm_port=self.litellm_port,
            manage_litellm=self.manage_litellm,
        )


@_APP.command
@dataclass
class Start(ModelOptions):
    """Start Neo4j, LiteLLM, and Graphiti."""

    graphiti_args: list[str] = field(default_factory=list, init=False)

    def __call__(self) -> int:
        return Runtime().start(extra_args=self.graphiti_args, settings=self.settings())


@_APP.command
@dataclass
class Up(ModelOptions):
    """Start Neo4j, LiteLLM, and Graphiti in the background."""

    graphiti_args: list[str] = field(default_factory=list, init=False)

    def __call__(self) -> None:
        runtime = Runtime()
        process_id = runtime.start(
            foreground=False,
            extra_args=self.graphiti_args,
            settings=self.settings(),
        )
        print(json.dumps({"graphiti_pid": process_id, **runtime.status()}, indent=2))


@_APP.command
@dataclass
class Down:
    """Stop Graphiti, LiteLLM, and Neo4j."""

    def __call__(self) -> None:
        Runtime().stop()


@_APP.command
@dataclass
class Status:
    """Show native process status."""

    def __call__(self) -> None:
        print(json.dumps(Runtime().status(), indent=2))


@_APP.command
@dataclass
class Env(ModelOptions):
    """Print resolved runtime settings, including the Neo4j password."""

    def __call__(self) -> None:
        runtime = Runtime()
        state = runtime.read_state()
        print(
            json.dumps(
                runtime.connection_settings(
                    str(state["neo4j_password"]),
                    self.settings(),
                ),
                indent=2,
            )
        )


def main(argv: Sequence[str] | None = None) -> None:
    arguments = list(sys.argv[1:] if argv is None else argv)
    if not arguments or arguments[0].startswith("-"):
        arguments.insert(0, "start")
    forwarded: list[str] = []
    if "--" in arguments:
        separator = arguments.index("--")
        forwarded = arguments[separator + 1 :]
        arguments = arguments[:separator]
    command, bound, _ = _APP.parse_args(arguments)
    options = command(*bound.args, **bound.kwargs)
    if options is None:
        return
    if isinstance(options, (Start, Up)):
        options.graphiti_args.extend(forwarded)
    result = options()
    if isinstance(result, int) and result:
        raise SystemExit(result)
