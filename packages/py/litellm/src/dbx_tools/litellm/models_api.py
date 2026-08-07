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

_EFFORT_DESCRIPTIONS = {
    "low": "Faster responses with lighter reasoning",
    "medium": "Balanced reasoning for general tasks",
    "high": "Deeper reasoning for complex tasks",
    "xhigh": "Maximum reasoning for the hardest tasks",
}
_BASIC_FAMILIES = ("gpt", "claude", "gemini", "llama", "qwen", "glm", "gemma")
logger = logging.getLogger(__name__)


def augment_models_payload(
    payload: Any,
    endpoints: Sequence[ServingEndpointSummary] | None = None,
) -> Any:
    """Prefer discovered endpoints, falling back to LiteLLM's bundled registry."""
    if not isinstance(payload, Mapping) or "models" in payload:
        return payload
    data = payload.get("data")
    if not isinstance(data, Sequence) or isinstance(data, (str, bytes, bytearray)):
        return payload
    augmented_data = _discovered_models(data, endpoints)
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
            logger.warning("Live model discovery failed; using LiteLLM registry: %s", error)
            endpoints = None
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
        slug = model_id.removeprefix("databricks/")
        if slug in {"*", "databricks/*"} or slug in seen:
            continue
        seen.add(slug)
        models.append(_codex_model(slug, item, priority=10_000 - len(models)))
    return models


def _discovered_models(
    data: Sequence[Any],
    endpoints: Sequence[ServingEndpointSummary] | None,
) -> list[Any]:
    """Use exact live endpoints and retain registry metadata only for matches."""
    if endpoints is None:
        return list(data)

    result: list[Any] = []
    registry: dict[str, Mapping[str, Any]] = {}
    for item in data:
        if not isinstance(item, Mapping):
            result.append(item)
            continue
        model_id = item.get("id")
        if not isinstance(model_id, str):
            result.append(item)
            continue
        slug = model_id.removeprefix("databricks/")
        if slug in {"*", "databricks/*"} or not slug.startswith(("databricks-", "system.ai.")):
            result.append(item)
            continue
        registry.setdefault(slug, item)

    seen: set[str] = set()
    for endpoint in endpoints:
        if endpoint.name in seen:
            continue
        existing = registry.get(endpoint.name)
        result.append(
            {
                **(dict(existing) if existing is not None else {}),
                "id": f"databricks/{endpoint.name}",
                "object": "model",
                "owned_by": "databricks",
            }
        )
        seen.add(endpoint.name)
    return result


def _append_family_models(data: Sequence[Any]) -> list[Any]:
    """Append one resolvable alias for each deployed basic model family."""
    result = list(data)
    existing = {
        model_id.removeprefix("databricks/")
        for item in data
        if isinstance(item, Mapping) and isinstance((model_id := item.get("id")), str)
    }
    representatives: dict[str, Mapping[str, Any]] = {}
    for item in data:
        if not isinstance(item, Mapping):
            continue
        model_id = item.get("id")
        if not isinstance(model_id, str):
            continue
        slug = model_id.removeprefix("databricks/")
        if slug in {"*", "databricks/*"}:
            continue
        family = _basic_family(slug)
        if family is not None:
            representatives.setdefault(family, item)

    for family, representative in representatives.items():
        alias = f"databricks-{family}"
        if alias in existing:
            continue
        result.append({**representative, "id": alias})
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
    context_window = item.get("max_input_tokens")
    if not isinstance(context_window, int) or context_window <= 0:
        context_window = None
    return {
        "slug": slug,
        "display_name": slug,
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
