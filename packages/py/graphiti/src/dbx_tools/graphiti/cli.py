from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Annotated

from cyclopts import App, Parameter

from ._cli import run_forwarding_app
from .runtime import Runtime
from .settings import ModelSettings

"""Command-line interface for the native Graphiti stack."""

_APP = App(
    name="dbx-graphiti",
    help="Run Graphiti MCP with a local native Neo4j backend (no containers).",
)


@dataclass
class ModelOptions:
    """Model, profile, and managed model gateway settings shared by commands."""

    profile: Annotated[
        str | None,
        Parameter(name="--profile"),
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
    model_gateway_url: Annotated[
        str | None,
        Parameter(name="--model-gateway-url", env_var="MODEL_GATEWAY_URL"),
    ] = None
    model_gateway_host: Annotated[
        str | None,
        Parameter(name="--model-gateway-host", env_var="MODEL_GATEWAY_HOST"),
    ] = None
    model_gateway_port: Annotated[
        int | None,
        Parameter(name="--model-gateway-port", env_var="MODEL_GATEWAY_PORT"),
    ] = None
    model_gateway_command: Annotated[
        str | None,
        Parameter(name="--model-gateway-command", env_var="MODEL_GATEWAY_COMMAND"),
    ] = None
    manage_model_gateway: Annotated[
        bool | None,
        Parameter(
            name="--manage-model-gateway",
            env_var="MANAGE_MODEL_GATEWAY",
            negative="--no-manage-model-gateway",
        ),
    ] = None

    def settings(self) -> ModelSettings:
        """Resolve CLI and environment values into runtime settings."""
        return ModelSettings.resolve(
            profile=self.profile,
            model=self.model,
            embedder_model=self.embedder_model,
            embedder_dimensions=self.embedder_dimensions,
            model_gateway_url=self.model_gateway_url,
            model_gateway_host=self.model_gateway_host,
            model_gateway_port=self.model_gateway_port,
            model_gateway_command=self.model_gateway_command,
            manage_model_gateway=self.manage_model_gateway,
        )


@_APP.command
@dataclass
class Start(ModelOptions):
    """Start Neo4j, the model gateway, and Graphiti."""

    graphiti_args: list[str] = field(default_factory=list, init=False)

    def __call__(self) -> int:
        return Runtime().start(extra_args=self.graphiti_args, settings=self.settings())


@_APP.command
@dataclass
class Up(ModelOptions):
    """Start Neo4j, the model gateway, and Graphiti in the background."""

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
    """Stop Graphiti, the model gateway, and Neo4j."""

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


def _bind_forwarded(options: object, forwarded: list[str]) -> None:
    if isinstance(options, (Start, Up)):
        options.graphiti_args.extend(forwarded)


def main(argv: Sequence[str] | None = None) -> None:
    run_forwarding_app(
        _APP,
        argv,
        bind_forwarded=_bind_forwarded,
        default_command="start",
    )
