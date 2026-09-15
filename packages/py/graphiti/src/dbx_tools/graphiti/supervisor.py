from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Annotated

from cyclopts import App, Parameter

from ._cli import run_forwarding_app
from .runtime import Runtime, RuntimePaths
from .settings import ModelSettings

"""Background entry point for the linked Graphiti process supervisor."""


@dataclass
class SupervisorOptions:
    """Detached Graphiti supervisor inputs."""

    home: Annotated[Path, Parameter(name="--home", env_var="DBX_GRAPHITI_HOME")]
    graphiti_args: list[str] = field(default_factory=list, init=False)

    def __call__(self) -> int:
        return Runtime(RuntimePaths(self.home)).supervise(
            ModelSettings.resolve(),
            self.graphiti_args,
        )


_APP = App(
    name="dbx-graphiti",
    default_command=SupervisorOptions,
)


def _bind_forwarded(options: object, forwarded: list[str]) -> None:
    if isinstance(options, SupervisorOptions):
        options.graphiti_args.extend(forwarded)


def main(argv: Sequence[str] | None = None) -> None:
    """Run the supervisor in a detached process."""
    run_forwarding_app(_APP, argv, bind_forwarded=_bind_forwarded)


if __name__ == "__main__":
    main()
