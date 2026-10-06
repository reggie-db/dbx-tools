"""Detached entry point for the linked Graphiti process supervisor."""

from __future__ import annotations

from .runtime import Runtime, RuntimePaths
from .settings import load_graphiti_options


def main() -> None:
    """Run the supervisor from the serialized generated Graphiti config."""
    options = load_graphiti_options()
    result = Runtime(RuntimePaths.from_options(options)).supervise(options)
    if result:
        raise SystemExit(result)


if __name__ == "__main__":
    main()
