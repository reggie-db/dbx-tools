"""Generated Graphiti configuration and Node-owned model resolution."""

from __future__ import annotations

import json
import os
from collections.abc import Mapping

from ._generated.node.model.bindings import (
    ResolvedModelRouteResponse,
    resolve_model_route,
)
from ._generated.node.shared_graphiti.options import (
    GraphitiOptions,
    ResolvedGraphitiOptionsResponse,
    graphiti_environment,
    resolve_graphiti_options,
)

GRAPHITI_OPTIONS_ENV = "DBX_GRAPHITI_OPTIONS"


def load_graphiti_options(
    environ: Mapping[str, str] | None = None,
) -> ResolvedGraphitiOptionsResponse:
    """Validate serialized options from the owning JavaScript CLI."""
    env = os.environ if environ is None else environ
    serialized = env.get(GRAPHITI_OPTIONS_ENV, "").strip()
    if not serialized:
        return resolve_graphiti_options()
    value = json.loads(serialized)
    if not isinstance(value, dict):
        raise TypeError(f"{GRAPHITI_OPTIONS_ENV} must contain a JSON object")
    return resolve_graphiti_options(value)


async def resolve_graphiti_models(
    options: ResolvedGraphitiOptionsResponse,
) -> tuple[
    ResolvedGraphitiOptionsResponse,
    ResolvedModelRouteResponse | None,
    ResolvedModelRouteResponse | None,
]:
    """Fuzzy-resolve managed Databricks chat and embedding endpoints."""
    if not options["manageModelGateway"]:
        return options, None, None
    profile = options.get("profile")
    model_route = await resolve_model_route(
        {
            **({"profile": profile} if profile else {}),
            "model": options["model"],
            "fuzzy": True,
            "modelClass": "chat-balanced",
            "protocol": "chat",
        }
    )
    embedder_route = await resolve_model_route(
        {
            **({"profile": profile} if profile else {}),
            "model": options["embedderModel"],
            "fuzzy": True,
            "modelClass": "embedding",
            "protocol": "embeddings",
        }
    )
    resolved = resolve_graphiti_options(
        {
            **options,
            "model": model_route["modelId"],
            "embedderModel": embedder_route["modelId"],
            "embedderDimensions": embedder_route.get("endpointDimension")
            or options["embedderDimensions"],
        }
    )
    return resolved, model_route, embedder_route


def provider_environment(options: ResolvedGraphitiOptionsResponse) -> dict[str, str]:
    """Return provider environment from the shared Zod configuration owner."""
    return graphiti_environment(options)


__all__ = [
    "GRAPHITI_OPTIONS_ENV",
    "GraphitiOptions",
    "ResolvedGraphitiOptionsResponse",
    "ResolvedModelRouteResponse",
    "load_graphiti_options",
    "provider_environment",
    "resolve_graphiti_models",
]
