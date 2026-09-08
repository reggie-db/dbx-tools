"""Live Databricks model APIs layered onto the LiteLLM proxy."""

from __future__ import annotations

import asyncio
import json
import logging
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import asdict
from typing import Annotated, Any

from databricks.sdk.errors import DatabricksError
from dbx_tools.model import (
    ModelQuery,
    RankedModel,
    ReasoningEffort,
    ServingEndpointSummary,
    lookup_models,
)
from dbx_tools.model.models import parse_model_name
from fastapi import Depends, Query, Request, Response
from fastapi.responses import JSONResponse

from .access_log import logger as access_logger
from .access_log import normalize_request_ip
from .backend import codex_gateway_model_name, get_backend
from .originator import is_codex_originator

_EFFORT_DESCRIPTIONS = {
    "low": "Faster responses with lighter reasoning",
    "medium": "Balanced reasoning for general tasks",
    "high": "Deeper reasoning for complex tasks",
    "xhigh": "Maximum reasoning for the hardest tasks",
}
_CODEX_BASE_INSTRUCTIONS = (
    "You are a coding agent. Follow the user's instructions and use the available "
    "tools to work in the current repository."
)
_MODEL_RESPONSE_PATHS = frozenset(
    {
        "/chat/completions",
        "/responses",
        "/v1/chat/completions",
        "/v1/responses",
    }
)
logger = logging.getLogger(__name__)


def install_models_compatibility_middleware() -> None:
    """Install live model lookup, listing, and response annotations."""
    from litellm.proxy.proxy_server import app, user_api_key_auth

    if getattr(app.state, "dbx_models_compatibility", False):
        return
    app.state.dbx_models_compatibility = True

    @app.get(
        "/lookup",
        dependencies=[Depends(user_api_key_auth)],
        operation_id="lookupModels",
        response_model=list[RankedModel],
        response_model_exclude_none=True,
        summary="Rank available Databricks models",
        tags=["model management"],
    )
    async def lookup_model_endpoints(
        request: Request,
        query: Annotated[ModelQuery, Query()],
    ) -> list[dict[str, object]]:
        try:
            catalogue = await asyncio.to_thread(get_backend().catalogue)
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

    @app.middleware("http")
    async def response_envelope(request: Request, call_next: Any) -> Response:
        path = request.scope.get("path")
        request_payload = await _request_json(request) if path in _MODEL_RESPONSE_PATHS else None
        response = await call_next(request)
        if request_payload is not None and response.status_code == 200:
            return await _model_identity_response(
                response,
                request_payload,
                get_backend(),
                request_path=path,
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
        _ = b"".join([chunk async for chunk in response.body_iterator])
        try:
            catalogue = await asyncio.to_thread(get_backend().catalogue)
            payload = list_models_payload(
                catalogue.endpoints,
                include_codex=is_codex_originator(request.headers.get("originator")),
            )
        except (DatabricksError, OSError, RuntimeError, ValueError) as error:
            logger.warning("Live model discovery failed: %s", error)
            payload = list_models_payload(
                (),
                include_codex=is_codex_originator(request.headers.get("originator")),
            )
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
    endpoints: Sequence[ServingEndpointSummary],
    *,
    include_codex: bool = True,
) -> dict[str, Any]:
    """Build model envelopes exclusively from the live Databricks catalogue."""
    available = [endpoint for endpoint in endpoints if not endpoint.status.deprecated]
    payload: dict[str, Any] = {
        "object": "list",
        "data": [_openai_model(endpoint) for endpoint in available],
    }
    if include_codex:
        codex_endpoints = [
            endpoint
            for endpoint in available
            if codex_gateway_model_name(endpoint.name) is not None
        ]
        payload["models"] = [
            _codex_model(endpoint, priority=index + 1)
            for index, endpoint in enumerate(codex_endpoints)
        ]
    return payload


def model_summary(payload: Any) -> str:
    """Summarize advertised models by parsed model family."""
    data = payload.get("data") if isinstance(payload, Mapping) else None
    if not isinstance(data, Sequence) or isinstance(data, (str, bytes, bytearray)):
        return "0 models"
    families: Counter[str] = Counter()
    for item in data:
        model_id = item.get("id") if isinstance(item, Mapping) else None
        if not isinstance(model_id, str):
            continue
        parsed = parse_model_name(model_id)
        families[parsed.family.value if parsed is not None else "other"] += 1
    total = sum(families.values())
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
    backend: Any,
    *,
    request_path: str,
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
    actual = _qualified_model(requested)
    if actual is None:
        tools = request_payload.get("tools")
        try:
            actual = await asyncio.to_thread(
                backend.resolve,
                requested,
                requires_tools=isinstance(tools, list) and bool(tools),
            )
        except (DatabricksError, OSError, RuntimeError, ValueError) as error:
            logger.warning("Response model annotation failed: %s", error)
    annotated = dict(payload)
    annotated["requestedModel"] = requested
    request_endpoint = _request_endpoint(
        response.headers.get("x-litellm-model-api-base"),
        request_path,
    )
    if request_endpoint is not None:
        annotated["requestEndpoint"] = request_endpoint
    if actual is not None:
        annotated["model"] = actual
    return JSONResponse(
        content=annotated,
        status_code=response.status_code,
        headers=_response_headers(response),
    )


def _request_endpoint(api_base: object, request_path: str) -> str | None:
    if not isinstance(api_base, str) or not api_base:
        return None
    base = api_base.rstrip("/")
    if request_path.endswith("/responses"):
        suffix = "/responses"
    elif request_path.endswith("/chat/completions"):
        suffix = "/chat/completions"
    else:
        return base
    if base.endswith(suffix):
        return base
    if base.endswith(
        (
            "/serving-endpoints",
            "/ai-gateway/codex/v1",
            "/ai-gateway/mlflow/v1",
        )
    ):
        return f"{base}{suffix}"
    return base


def _qualified_model(requested: str) -> str | None:
    normalized = (
        requested.removeprefix("dbx/").removeprefix("databricks/").removeprefix("responses/")
    )
    if normalized.startswith(("databricks-", "system.ai.")):
        return normalized
    return None


def _openai_model(endpoint: ServingEndpointSummary) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "id": endpoint.name,
        "object": "model",
        "owned_by": "databricks",
        "name": endpoint.display_name or endpoint.name,
        "status": asdict(endpoint.status),
    }
    if endpoint.task is not None:
        entry["task"] = endpoint.task
    return entry


def _codex_model(endpoint: ServingEndpointSummary, *, priority: int) -> dict[str, Any]:
    efforts = endpoint.reasoning_efforts
    names = [effort.value for effort in efforts]
    gateway_model = codex_gateway_model_name(endpoint.name)
    if gateway_model is None:
        raise ValueError(f'Model "{endpoint.name}" is not supported by the Codex gateway')
    entry = {
        "slug": f"databricks/{gateway_model}",
        "display_name": endpoint.display_name or endpoint.name,
        "description": endpoint.description or "Databricks Model Serving endpoint",
        "base_instructions": _CODEX_BASE_INSTRUCTIONS,
        "status": asdict(endpoint.status),
        "supported_reasoning_levels": [],
        "shell_type": "shell_command",
        "visibility": "list",
        "supported_in_api": True,
        "priority": priority,
        "availability_nux": None,
        "upgrade": None,
        "support_verbosity": False,
        "default_verbosity": None,
        "apply_patch_tool_type": None,
        "truncation_policy": {"mode": "tokens", "limit": 128_000},
        "context_window": None,
        "experimental_supported_tools": [],
        "input_modalities": ["text"],
    }
    if names:
        entry["default_reasoning_level"] = (
            ReasoningEffort.MEDIUM.value if ReasoningEffort.MEDIUM.value in names else names[0]
        )
        entry["supported_reasoning_levels"] = [
            {
                "effort": effort,
                "description": _EFFORT_DESCRIPTIONS.get(
                    effort,
                    f"{effort} reasoning effort",
                ),
            }
            for effort in names
        ]
    return entry


def _request_ip(request: Request) -> str:
    forwarded = normalize_request_ip(request.headers.get("x-forwarded-for"))
    if forwarded is not None:
        return forwarded
    client = request.client
    return normalize_request_ip(client.host if client is not None else None) or "unknown"


def _response_headers(response: Response) -> dict[str, str]:
    return {
        key: value
        for key, value in response.headers.items()
        if key.lower() not in {"content-length", "content-type"}
    }
