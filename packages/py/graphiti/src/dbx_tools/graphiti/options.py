from typing import TypeAlias

from ._generated.node.shared_graphiti.options import (
    GraphitiOptions,
    GraphitiOptionsResponse,
    ResolvedGraphitiOptionsResponse,
    resolve_graphiti_options,
)

"""Normalize Python and generated Graphiti option representations."""

GraphitiOptionsInput: TypeAlias = (
    GraphitiOptions | GraphitiOptionsResponse | ResolvedGraphitiOptionsResponse
)


def normalize_graphiti_options(
    options: GraphitiOptionsInput | None = None,
) -> ResolvedGraphitiOptionsResponse:
    """Resolve defaults for a generated dataclass, option record, or resolved record."""
    if options is None:
        return resolve_graphiti_options()
    return resolve_graphiti_options(options)
