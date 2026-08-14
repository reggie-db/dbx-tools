from __future__ import annotations

import sys
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Annotated

from cyclopts import App, Parameter

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


def main(argv: Sequence[str] | None = None) -> None:
    """Run the supervisor in a detached process."""
    arguments = list(sys.argv[1:] if argv is None else argv)
    forwarded: list[str] = []
    if "--" in arguments:
        separator = arguments.index("--")
        forwarded = arguments[separator + 1 :]
        arguments = arguments[:separator]
    command, bound, _ = _APP.parse_args(arguments)
    options = command(*bound.args, **bound.kwargs)
    if options is None:
        return
    options.graphiti_args.extend(forwarded)
    result = options()
    if isinstance(result, int) and result:
        raise SystemExit(result)


if __name__ == "__main__":
    main()
