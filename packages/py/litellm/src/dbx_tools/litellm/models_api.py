"""Model discovery compatibility for the standard API view."""

from __future__ import annotations

import asyncio
import json
import logging
from collections import Counter
from collections.abc import Mapping, Sequence
from typing import Annotated, Any

from databricks.sdk.errors import DatabricksError
from dbx_tools.model import (
    ModelQuery,
    RankedModel,
    ServingEndpointSummary,
    lookup_models,
    reasoning_efforts_by_family,
)
from dbx_tools.model.models import parse_model_name
from fastapi import Depends, Query, Request, Response
from fastapi.responses import JSONResponse

from litellm import model_cost

from .access_log import logger as access_logger
from .access_log import normalize_request_ip

_EFFORT_DESCRIPTIONS = {
    "low": "Faster responses with lighter reasoning",
    "medium": "Balanced reasoning for general tasks",
    "high": "Deeper reasoning for complex tasks",
    "xhigh": "Maximum reasoning for the hardest tasks",
}
_ROUTE_MODEL_IDS = frozenset({"*", "databricks/*", "dbx/*"})
_MODEL_RESPONSE_PATHS = frozenset(
    {
        "/chat/completions",
        "/responses",
        "/v1/chat/completions",
        "/v1/responses",
    }
)
logger = logging.getLogger(__name__)


_PROXY_MODEL_SEED: dict[str, Any] = {
    "object": "list",
    "data": [
        {"id": "*", "object": "model"},
        {"id": "dbx/*", "object": "model"},
    ],
}


def augment_models_payload(
    payload: Any,
    endpoints: Sequence[ServingEndpointSummary] | None = None,
) -> Any:
    """Advertise exact models in OpenAI and Codex envelopes."""
    if not isinstance(payload, Mapping) or "models" in payload:
        return payload
    data = payload.get("data")
    if not isinstance(data, Sequence) or isinstance(data, (str, bytes, bytearray)):
        return payload
    native_enabled = any(
        isinstance(item, Mapping) and item.get("id") == "databricks/*" for item in data
    )
    augmented_data = _discovered_models(data, endpoints, native_enabled=native_enabled)
    return {**payload, "data": augmented_data, "models": _codex_models(augmented_data)}


def install_models_compatibility_middleware() -> None:
    from litellm.proxy.proxy_server import app, user_api_key_auth

    from .provider import dbx_provider

    if getattr(app.state, "dbx_models_compatibility", False):
        return
    app.state.dbx_models_compatibility = True

    @app.get(
        "/v1/models/lookup",
        dependencies=[Depends(user_api_key_auth)],
        operation_id="lookupModels",
        response_model=list[RankedModel],
        response_model_exclude_none=True,
        summary="Rank available models",
        tags=["model management"],
    )
    async def lookup_model_endpoints(
        request: Request,
        query: Annotated[ModelQuery, Query()],
    ) -> list[dict[str, object]]:
        try:
            catalogue = await asyncio.to_thread(dbx_provider.backend.catalogue)
            result = lookup_models(catalogue.endpoints, query)
        except (DatabricksError, OSError, RuntimeError, ValueError) as error:
            logger.warning("Live model lookup failed: %s", error)
            result = []
        access_logger.info(
            "status=ok ip=%s call=model_lookup search=%r matches=%d",
            _request_ip(request),
            query.search,
            len(result),
        )
        return result

    # OpenAI places model operations under `/v1/models`. LiteLLM's dynamic
    # `/v1/models/{model_id}` route is registered first, so this static extension
    # must precede it to keep "lookup" from being interpreted as a model id.
    lookup_route = next(
        route for route in app.router.routes if getattr(route, "path", None) == "/v1/models/lookup"
    )
    model_route_index = next(
        index
        for index, route in enumerate(app.router.routes)
        if _route_contains_path(route, "/v1/models/{model_id}")
    )
    app.router.routes.remove(lookup_route)
    app.router.routes.insert(model_route_index, lookup_route)

    @app.middleware("http")
    async def response_envelope(request: Request, call_next: Any) -> Response:
        path = request.scope.get("path")
        request_payload = await _request_json(request) if path in _MODEL_RESPONSE_PATHS else None
        response = await call_next(request)
        if request_payload is not None and response.status_code == 200:
            return await _model_identity_response(
                response,
                request_payload,
                dbx_provider,
            )
        if path != "/v1/models":
            return response
        request_ip = _request_ip(request)
        if response.status_code != 200:
            access_logger.warning(
                "status=error ip=%s call=models http_status=%d",
                request_ip,
                response.status_code,
            )
            return response

        body = b"".join([chunk async for chunk in response.body_iterator])
        try:
            payload = json.loads(body)
        except (TypeError, ValueError):
            access_logger.warning(
                "status=error ip=%s call=models http_status=%d summary=%r",
                request_ip,
                response.status_code,
                "invalid response payload",
            )
            return Response(
                content=body,
                status_code=response.status_code,
                headers=_response_headers(response),
                media_type=response.media_type,
            )
        try:
            catalogue = await asyncio.to_thread(dbx_provider.backend.catalogue)
            endpoints = catalogue.endpoints
        except (DatabricksError, OSError, RuntimeError, ValueError) as error:
            endpoints = None
            logger.warning("Live model discovery failed; using LiteLLM registry: %s", error)
        payload = augment_models_payload(payload, endpoints)
        access_logger.info(
            "status=ok ip=%s call=models http_status=%d summary=%r",
            request_ip,
            response.status_code,
            model_summary(payload),
        )
        return JSONResponse(
            content=payload,
            status_code=response.status_code,
            headers=_response_headers(response),
        )

    app.openapi_schema = None


def list_models_payload(
    endpoints: Sequence[ServingEndpointSummary] | None = None,
) -> Any:
    """Return the `/v1/models` envelope advertised by the packaged proxy.

    The seed is the packaged route placeholders (`*` and `dbx/*`). Live
    discovery replaces those with exact `dbx/<endpoint>` ids, matching a
    running proxy whose LiteLLM config advertises the same routes.
    """
    return augment_models_payload(_PROXY_MODEL_SEED, endpoints)


def model_summary(payload: Any) -> str:
    """Summarize advertised models by parsed model family."""
    data = payload.get("data") if isinstance(payload, Mapping) else None
    if not isinstance(data, Sequence) or isinstance(data, (str, bytes, bytearray)):
        return "0 models"
    families: Counter[str] = Counter()
    total = 0
    for item in data:
        if not isinstance(item, Mapping):
            continue
        model_id = item.get("id")
        if not isinstance(model_id, str) or model_id in _ROUTE_MODEL_IDS:
            continue
        parsed = parse_model_name(model_id)
        families[parsed.family.value if parsed is not None else "other"] += 1
        total += 1
    noun = "model" if total == 1 else "models"
    if not families:
        return f"{total} {noun}"
    counts = ", ".join(f"{count} {family}" for family, count in sorted(families.items()))
    return f"{total} {noun} ({counts})"


async def _request_json(request: Request) -> Mapping[str, Any] | None:
    try:
        payload = json.loads(await request.body())
    except (TypeError, ValueError):
        return None
    return payload if isinstance(payload, Mapping) else None


async def _model_identity_response(
    response: Response,
    request_payload: Mapping[str, Any],
    provider: Any,
) -> Response:
    content_type = response.headers.get("content-type", "")
    requested = request_payload.get("model")
    if "application/json" not in content_type or not isinstance(requested, str) or not requested:
        return response
    body = b"".join([chunk async for chunk in response.body_iterator])
    try:
        payload = json.loads(body)
    except (TypeError, ValueError):
        return Response(
            content=body,
            status_code=response.status_code,
            headers=_response_headers(response),
            media_type=response.media_type,
        )
    if not isinstance(payload, Mapping):
        return JSONResponse(
            content=payload,
            status_code=response.status_code,
            headers=_response_headers(response),
        )
    actual = _qualified_endpoint(requested)
    if actual is None:
        tools = request_payload.get("tools")
        try:
            actual = await asyncio.to_thread(
                provider.backend.resolve,
                requested,
                requires_tools=isinstance(tools, list) and bool(tools),
            )
        except (DatabricksError, OSError, RuntimeError, ValueError) as error:
            logger.warning("Response model annotation failed: %s", error)
    annotated = dict(payload)
    annotated["requestedModel"] = requested
    if actual is not None:
        annotated["model"] = actual
    return JSONResponse(
        content=annotated,
        status_code=response.status_code,
        headers=_response_headers(response),
    )


def _qualified_endpoint(requested: str) -> str | None:
    normalized = requested.removeprefix("dbx/")
    if normalized.startswith("databricks/"):
        return normalized.removeprefix("databricks/").removeprefix("responses/")
    if normalized.startswith(("databricks-", "system.ai.")):
        return normalized
    return None


def _request_ip(request: Request) -> str:
    forwarded = normalize_request_ip(request.headers.get("x-forwarded-for"))
    if forwarded is not None:
        return forwarded
    client = request.client
    return normalize_request_ip(client.host if client is not None else None) or "unknown"


def _route_contains_path(route: Any, path: str) -> bool:
    if getattr(route, "path", None) == path:
        return True
    router = getattr(route, "original_router", None)
    return any(_route_contains_path(candidate, path) for candidate in getattr(router, "routes", ()))


def _codex_models(data: Sequence[Any]) -> list[dict[str, Any]]:
    models: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in data:
        if not isinstance(item, Mapping):
            continue
        model_id = item.get("id")
        if not isinstance(model_id, str):
            continue
        if model_id in _ROUTE_MODEL_IDS or model_id in seen:
            continue
        seen.add(model_id)
        models.append(_codex_model(model_id, item, priority=10_000 - len(models)))
    return models


def _discovered_models(
    data: Sequence[Any],
    endpoints: Sequence[ServingEndpointSummary] | None,
    *,
    native_enabled: bool,
) -> list[Any]:
    """Use exact live endpoints and expose every Databricks model through dbx."""
    if endpoints is None:
        return _registry_models(data, native_enabled=native_enabled)

    result = _custom_models(data)
    registry: dict[str, Mapping[str, Any]] = {}
    for item in data:
        if not isinstance(item, Mapping):
            continue
        model_id = item.get("id")
        if not isinstance(model_id, str):
            continue
        slug = _databricks_slug(model_id)
        if slug is not None:
            registry.setdefault(slug, item)

    seen: set[str] = set()
    for endpoint in endpoints:
        if endpoint.name in seen:
            continue
        existing = registry.get(endpoint.name)
        result.append(
            _model_entry(
                _dbx_model_id(endpoint.name),
                existing,
                owned_by="dbx",
                endpoint=endpoint,
            )
        )
        if native_enabled:
            result.append(
                _model_entry(
                    f"databricks/{endpoint.name}",
                    existing,
                    owned_by="databricks",
                    endpoint=endpoint,
                )
            )
        seen.add(endpoint.name)
    return result


def _registry_models(data: Sequence[Any], *, native_enabled: bool) -> list[Any]:
    """Rewrite bundled Databricks entries through dbx when discovery is unavailable."""
    result = _custom_models(data)
    seen = {
        item.get("id")
        for item in result
        if isinstance(item, Mapping) and isinstance(item.get("id"), str)
    }
    for item in data:
        if not isinstance(item, Mapping):
            continue
        model_id = item.get("id")
        if not isinstance(model_id, str):
            continue
        slug = _databricks_slug(model_id)
        dbx_id = _dbx_model_id(slug) if slug is not None else None
        if dbx_id is None or dbx_id in seen:
            continue
        result.append(_model_entry(dbx_id, item, owned_by="dbx"))
        seen.add(dbx_id)
        if native_enabled:
            native_id = f"databricks/{slug}"
            if native_id not in seen:
                result.append(_model_entry(native_id, item, owned_by="databricks"))
                seen.add(native_id)
    return result


def _portable_display_name(model_id: str, endpoint: ServingEndpointSummary | None) -> str:
    """Return a concise UI label without changing the routable model id."""
    if endpoint is not None and endpoint.display_name:
        return endpoint.display_name
    slug = model_id.removeprefix("dbx/").removeprefix("databricks/")
    slug = slug.removeprefix("databricks-").removeprefix("system.ai.")
    return " ".join(
        part.upper() if part in {"gpt", "glm"} else part.capitalize() for part in slug.split("-")
    )


def _context_window(model_id: str, existing: Mapping[str, Any] | None) -> int | None:
    """Resolve input context metadata from the registry entry or LiteLLM catalogue."""
    candidates = [
        existing.get("context_window") if existing else None,
        existing.get("max_input_tokens") if existing else None,
    ]
    slug = model_id.removeprefix("dbx/").removeprefix("databricks/")
    for candidate in (slug, f"databricks/{slug}"):
        model_info = model_cost.get(candidate)
        if isinstance(model_info, Mapping):
            candidates.append(model_info.get("max_input_tokens"))
    return next((value for value in candidates if isinstance(value, int) and value > 0), None)


def _model_entry(
    model_id: str,
    existing: Mapping[str, Any] | None,
    *,
    owned_by: str,
    endpoint: ServingEndpointSummary | None = None,
) -> dict[str, Any]:
    """Build a concise OpenAI model entry without reasoning metadata."""
    entry = {
        **(dict(existing) if existing is not None else {}),
        "id": model_id,
        "object": "model",
        "owned_by": owned_by,
    }
    entry["name"] = _portable_display_name(model_id, endpoint)
    context_window = _context_window(model_id, existing)
    if context_window is not None:
        entry["context_window"] = context_window
        entry["max_input_tokens"] = context_window
    for key in (
        "supports_reasoning",
        "reasoning_efforts",
        "supported_reasoning_levels",
        "default_reasoning_effort",
    ):
        entry.pop(key, None)
    entry.pop("alias", None)
    return entry


def _custom_models(data: Sequence[Any]) -> list[Any]:
    """Retain explicit non-Databricks models while dropping route placeholders."""
    return [
        item
        for item in data
        if not (
            isinstance(item, Mapping)
            and isinstance((model_id := item.get("id")), str)
            and (
                model_id in _ROUTE_MODEL_IDS
                or (not model_id.startswith("dbx/") and _databricks_slug(model_id) is not None)
            )
        )
    ]


def _databricks_slug(model_id: str) -> str | None:
    """Normalize a LiteLLM native or already-dbx Databricks model id."""
    normalized = model_id.removeprefix("dbx/").removeprefix("databricks/")
    if normalized.startswith(("databricks-", "system.ai.")):
        return normalized
    return None


def _dbx_model_id(slug: str) -> str:
    """Qualify one resolved model for this package's custom provider."""
    return f"dbx/{slug.removeprefix('dbx/').removeprefix('databricks/')}"


def _codex_model(slug: str, item: Mapping[str, Any], *, priority: int) -> dict[str, Any]:
    efforts = [effort.value for effort in reasoning_efforts_by_family(slug)]
    default_effort = "medium" if "medium" in efforts else efforts[0] if efforts else None
    context_window = _context_window(slug, item)
    return {
        "slug": slug,
        "display_name": str(item.get("name") or _portable_display_name(slug, None)),
        "description": "Databricks Model Serving endpoint",
        "default_reasoning_level": default_effort,
        "supported_reasoning_levels": [
            {
                "effort": effort,
                "description": _EFFORT_DESCRIPTIONS.get(effort, f"{effort} reasoning effort"),
            }
            for effort in efforts
        ],
        "shell_type": "shell_command",
        "visibility": "list",
        "supported_in_api": True,
        "priority": priority,
        "availability_nux": None,
        "upgrade": None,
        "supports_reasoning_summary_parameter": "claude" not in slug.lower(),
        "support_verbosity": False,
        "default_verbosity": None,
        "apply_patch_tool_type": None,
        "truncation_policy": {"mode": "tokens", "limit": context_window or 128_000},
        "supports_parallel_tool_calls": True,
        "context_window": context_window,
        "experimental_supported_tools": [],
        "input_modalities": ["text"],
    }


def _response_headers(response: Response) -> dict[str, str]:
    return {
        key: value
        for key, value in response.headers.items()
        if key.lower() not in {"content-length", "content-type"}
    }
