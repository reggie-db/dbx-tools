"""Command-line interface for the native Graphiti stack."""

from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Annotated

from cyclopts import App, Parameter

from ._cli import run_forwarding_app

if TYPE_CHECKING:
    from .settings import ModelSettings

_APP = App(
    name="dbx-graphiti",
    help="Run Graphiti MCP with a local native Neo4j backend (no containers).",
)


@dataclass
class ModelOptions:
    """Model, profile, and managed model gateway settings shared by commands."""

    profile: Annotated[
        str | None,
        Parameter(name="--profile", help="Databricks profile used by the managed model gateway."),
    ] = None
    model: Annotated[
        str | None,
        Parameter(
            name="--model",
            env_var="MODEL_NAME",
            help="Model used to extract and query graph memory.",
        ),
    ] = None
    embedder_model: Annotated[
        str | None,
        Parameter(
            name="--embedder-model",
            env_var="EMBEDDER_MODEL",
            help="Embedding model used to index graph memory.",
        ),
    ] = None
    embedder_dimensions: Annotated[
        int | None,
        Parameter(
            name="--embedder-dimensions",
            env_var="EMBEDDER_DIMENSIONS",
            help="Number of dimensions returned by the embedding model.",
        ),
    ] = None
    model_gateway_url: Annotated[
        str | None,
        Parameter(
            name="--model-gateway-url",
            env_var="MODEL_GATEWAY_URL",
            help="Existing OpenAI-compatible gateway URL, including /v1.",
        ),
    ] = None
    model_gateway_host: Annotated[
        str | None,
        Parameter(
            name="--model-gateway-host",
            env_var="MODEL_GATEWAY_HOST",
            help="Host for the locally managed model gateway.",
        ),
    ] = None
    model_gateway_port: Annotated[
        int | None,
        Parameter(
            name="--model-gateway-port",
            env_var="MODEL_GATEWAY_PORT",
            help="Port for the locally managed model gateway.",
        ),
    ] = None
    model_gateway_command: Annotated[
        str | None,
        Parameter(
            name="--model-gateway-command",
            env_var="MODEL_GATEWAY_COMMAND",
            help="Command used to launch the managed model gateway.",
        ),
    ] = None
    manage_model_gateway: Annotated[
        bool | None,
        Parameter(
            name="--manage-model-gateway",
            env_var="MANAGE_MODEL_GATEWAY",
            negative="--no-manage-model-gateway",
            help="Start and stop a local model gateway with Graphiti; disable to use an existing gateway.",
        ),
    ] = None

    def settings(self) -> ModelSettings:
        """Resolve CLI and environment values into runtime settings."""
        from .settings import ModelSettings

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
        from .runtime import Runtime

        return Runtime().start(extra_args=self.graphiti_args, settings=self.settings())


@_APP.command
@dataclass
class Up(ModelOptions):
    """Start Neo4j, the model gateway, and Graphiti in the background."""

    graphiti_args: list[str] = field(default_factory=list, init=False)

    def __call__(self) -> None:
        from .runtime import Runtime

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
        from .runtime import Runtime

        Runtime().stop()


@_APP.command
@dataclass
class Status:
    """Show native process status."""

    def __call__(self) -> None:
        from .runtime import Runtime

        print(json.dumps(Runtime().status(), indent=2))


@_APP.command
@dataclass
class Env(ModelOptions):
    """Print resolved runtime settings, including the Neo4j password."""

    def __call__(self) -> None:
        from .runtime import Runtime

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
    """Run the Graphiti CLI, defaulting to the start command."""

    run_forwarding_app(
        _APP,
        argv,
        bind_forwarded=_bind_forwarded,
        default_command="start",
    )
