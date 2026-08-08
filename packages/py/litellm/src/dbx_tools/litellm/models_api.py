"""Model discovery compatibility and resolvable family aliases."""

from __future__ import annotations

import asyncio
import json
import logging
import re
from collections.abc import Mapping, Sequence
from typing import Any

from databricks.sdk.errors import DatabricksError
from dbx_tools.model import ServingEndpointSummary, reasoning_efforts_by_family
from fastapi import Request, Response
from fastapi.responses import JSONResponse

from litellm import model_cost

_EFFORT_DESCRIPTIONS = {
    "low": "Faster responses with lighter reasoning",
    "medium": "Balanced reasoning for general tasks",
    "high": "Deeper reasoning for complex tasks",
    "xhigh": "Maximum reasoning for the hardest tasks",
}
_BASIC_FAMILIES = ("gpt", "claude", "gemini", "llama", "qwen", "glm", "gemma")
_ROUTE_MODEL_IDS = frozenset({"*", "databricks/*", "dbx/*"})
logger = logging.getLogger(__name__)


def augment_models_payload(
    payload: Any,
    endpoints: Sequence[ServingEndpointSummary] | None = None,
) -> Any:
    """Advertise dbx-routed models from discovery or LiteLLM registry metadata."""
    if not isinstance(payload, Mapping) or "models" in payload:
        return payload
    data = payload.get("data")
    if not isinstance(data, Sequence) or isinstance(data, (str, bytes, bytearray)):
        return payload
    native_enabled = any(
        isinstance(item, Mapping) and item.get("id") == "databricks/*" for item in data
    )
    augmented_data = _discovered_models(data, endpoints, native_enabled=native_enabled)
    augmented_data = _append_family_models(augmented_data)
    return {**payload, "data": augmented_data, "models": _codex_models(augmented_data)}


def install_models_compatibility_middleware() -> None:
    from litellm.proxy.proxy_server import app

    from .provider import dbx_provider

    if getattr(app.state, "dbx_models_compatibility", False):
        return
    app.state.dbx_models_compatibility = True

    @app.middleware("http")
    async def add_codex_models_envelope(request: Request, call_next: Any) -> Response:
        response = await call_next(request)
        if request.url.path != "/v1/models" or response.status_code != 200:
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
        try:
            endpoints = await asyncio.to_thread(dbx_provider.backend.models, force=True)
        except (DatabricksError, OSError, RuntimeError, ValueError) as error:
            endpoints = dbx_provider.backend.cached_models()
            source = "cached endpoint catalogue" if endpoints else "LiteLLM registry"
            logger.warning("Live model discovery failed; using %s: %s", source, error)
        payload = augment_models_payload(payload, endpoints)
        return JSONResponse(
            content=payload,
            status_code=response.status_code,
            headers=_response_headers(response),
        )


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
    return " ".join(part.upper() if part in {"gpt", "glm"} else part.capitalize() for part in slug.split("-"))


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


def _append_family_models(data: Sequence[Any]) -> list[Any]:
    """Append one resolvable alias for each deployed basic model family."""
    result = list(data)
    existing = {
        model_id
        for item in data
        if isinstance(item, Mapping) and isinstance((model_id := item.get("id")), str)
    }
    representatives: dict[str, Mapping[str, Any]] = {}
    for item in data:
        if not isinstance(item, Mapping):
            continue
        model_id = item.get("id")
        if not isinstance(model_id, str) or not model_id.startswith("dbx/"):
            continue
        slug = model_id.removeprefix("dbx/")
        family = _basic_family(slug)
        if family is not None:
            representatives.setdefault(family, item)

    for family, representative in representatives.items():
        alias = f"dbx/databricks-{family}"
        if alias in existing:
            continue
        result.append(_model_entry(alias, representative, owned_by="dbx"))
        existing.add(alias)
    return result


def _basic_family(model: str) -> str | None:
    normalized = model.lower()
    if not normalized.startswith(("databricks-", "system.ai.")):
        return None
    tokens = set(re.findall(r"[a-z0-9]+", normalized))
    if "gpt" in tokens and "oss" in tokens:
        return "gpt-oss"
    return next(
        (family for family in _BASIC_FAMILIES if any(token.startswith(family) for token in tokens)),
        None,
    )


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
