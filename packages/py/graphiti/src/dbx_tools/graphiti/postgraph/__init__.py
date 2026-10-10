"""PostgreSQL graph driver maintained by dbx-tools.

Derived from the Apache-2.0 PostGraph driver originally developed in the
``crajah/graphiti`` fork. See ``LICENSE.upstream`` for attribution.
"""

from importlib import import_module
from typing import Any

__all__ = ["PostGraphDriver", "PostGraphDriverSession"]


def __getattr__(name: str) -> Any:
    """Load driver classes lazily so package and module imports are cycle-safe."""
    if name in __all__:
        module = import_module("dbx_tools.graphiti.postgraph.driver")
        return getattr(module, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

