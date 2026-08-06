"""Compatibility envelope for Codex model discovery."""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from typing import Any

from dbx_tools.model import reasoning_efforts_by_family
from fastapi import Request, Response
from fastapi.responses import JSONResponse

_EFFORT_DESCRIPTIONS = {
    "low": "Faster responses with lighter reasoning",
    "medium": "Balanced reasoning for general tasks",
    "high": "Deeper reasoning for complex tasks",
    "xhigh": "Maximum reasoning for the hardest tasks",
}


def augment_models_payload(payload: Any) -> Any:
    if not isinstance(payload, Mapping) or "models" in payload:
        return payload
    data = payload.get("data")
    if not isinstance(data, Sequence) or isinstance(data, (str, bytes, bytearray)):
        return payload
    return {**payload, "models": _codex_models(data)}


def install_models_compatibility_middleware() -> None:
    from litellm.proxy.proxy_server import app

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
            payload = augment_models_payload(json.loads(body))
        except (TypeError, ValueError):
            return Response(
                content=body,
                status_code=response.status_code,
                headers=_response_headers(response),
                media_type=response.media_type,
            )
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
