from __future__ import annotations

import sys
from collections.abc import Callable, Sequence

from cyclopts import App


def run_forwarding_app(
    app: App,
    argv: Sequence[str] | None,
    *,
    bind_forwarded: Callable[[object, list[str]], None],
    default_command: str | None = None,
) -> None:
    """Parse a Cyclopts command while forwarding arguments after ``--``."""
    arguments = list(sys.argv[1:] if argv is None else argv)
    if default_command is not None and (not arguments or arguments[0].startswith("-")):
        arguments.insert(0, default_command)
    forwarded: list[str] = []
    if "--" in arguments:
        separator = arguments.index("--")
        forwarded = arguments[separator + 1 :]
        arguments = arguments[:separator]
    command, bound, _ = app.parse_args(arguments)
    options = command(*bound.args, **bound.kwargs)
    if options is None:
        return
    bind_forwarded(options, forwarded)
    result = options()
    if isinstance(result, int) and result:
        raise SystemExit(result)
