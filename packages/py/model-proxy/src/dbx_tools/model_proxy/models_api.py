"""Dynamic model discovery routes for the LiteLLM proxy."""

from __future__ import annotations

from collections.abc import Mapping
from copy import deepcopy
from typing import Any

from fastapi import Depends, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse

from .runtime import get_runtime

_CODEX_BASE_INSTRUCTIONS = (
    "You are a coding agent. Follow the user's instructions and use the available "
    "tools to work in the current repository."
)
_CODEX_UNSUPPORTED_FAMILIES = frozenset({"bge", "claude", "gemini", "gte", "inkling"})
_REASONING_DESCRIPTIONS = {
    "none": "Disable explicit reasoning",
    "minimal": "Use the smallest available reasoning budget",
    "low": "Use a low reasoning budget",
    "medium": "Use a medium reasoning budget",
    "high": "Use a high reasoning budget",
    "xhigh": "Use an extra-high reasoning budget",
    "max": "Use the largest available reasoning budget",
}
_ROUTED_API_SUFFIXES = (
    "/chat/completions",
    "/completions",
    "/embeddings",
    "/responses",
)


def install_models_api() -> None:
    """Install live model listing and lookup once on LiteLLM's FastAPI app."""
    from litellm.proxy.proxy_server import app, user_api_key_auth

    if getattr(app.state, "dbx_models_api", False):
        return
    app.state.dbx_models_api = True
    _disable_litellm_ui(app)

    @app.get("/api/healthz", include_in_schema=False)
    async def health() -> dict[str, bool]:
        return {"ready": True}

    @app.get("/api/auth", include_in_schema=False)
    async def auth_status() -> dict[str, Any]:
        return {"runtime": await (await get_runtime()).status()}

    @app.get("/api/auth/profiles", include_in_schema=False)
    async def auth_profiles(refresh: bool = False) -> dict[str, Any]:
        return {"profiles": await (await get_runtime()).profiles(refresh=refresh)}

    @app.put("/api/auth", include_in_schema=False)
    async def select_auth(request: Request) -> dict[str, Any]:
        _require_control_request(request)
        selection = await request.json()
        if not isinstance(selection, Mapping):
            raise HTTPException(status_code=400, detail="auth selection must be an object")
        kind = selection.get("kind")
        if kind == "ambient":
            profile = None
        elif kind == "profile" and isinstance(selection.get("profile"), str):
            profile = selection["profile"].strip()
            if not profile:
                raise HTTPException(status_code=400, detail="profile must not be empty")
        else:
            raise HTTPException(status_code=400, detail="expected ambient or profile selection")
        return {"runtime": await (await get_runtime()).switch_profile(profile)}

    @app.get(
        "/lookup",
        dependencies=[Depends(user_api_key_auth)],
        operation_id="lookupDatabricksModels",
        tags=["model management"],
    )
    async def lookup_models(
        search: str | None = Query(
            default=None,
            description="Optional fuzzy model-name search. Lower scores are closer matches.",
        ),
        model_class: str | None = Query(
            default=None,
            alias="modelClass",
            description=(
                "Model-class ceiling: chat-thinking, chat-balanced, chat-fast, or embedding."
            ),
        ),
        requires_tools: bool | None = Query(
            default=None,
            alias="requiresTools",
            description="Only return endpoints with complete tool-calling support.",
        ),
        include_deprecated: bool | None = Query(
            default=None,
            alias="includeDeprecated",
            description="Include retired or deprecated endpoints in ranking.",
        ),
        limit: int | None = Query(
            default=None,
            ge=1,
            le=50,
            description="Maximum number of ranked matches.",
        ),
        threshold: float | None = Query(
            default=None,
            ge=0,
            le=1,
            description="Maximum fuzzy-match distance, where zero is exact.",
        ),
        refresh: bool = Query(
            default=False,
            description="Refresh the workspace model catalogue before ranking.",
        ),
    ) -> list[dict[str, Any]]:
        query = {
            key: value
            for key, value in {
                "search": search,
                "modelClass": model_class,
                "requiresTools": requires_tools,
                "includeDeprecated": include_deprecated,
                "limit": limit,
                "threshold": threshold,
            }.items()
            if value is not None
        }
        return await (await get_runtime()).lookup(query, refresh=refresh)

    @app.middleware("http")
    async def dynamic_models(request: Request, call_next: Any) -> Response:
        response = await call_next(request)
        if request.url.path != "/v1/models" or response.status_code != 200:
            return response
        _ = b"".join([chunk async for chunk in response.body_iterator])
        endpoints = await (await get_runtime()).models()
        payload = list_models_payload(
            endpoints,
            include_codex=_is_codex_originator(request.headers.get("originator")),
        )
        return JSONResponse(payload, status_code=response.status_code, headers=_headers(response))

    base_openapi = app.openapi
    app.openapi_schema = None

    def dbx_openapi() -> dict[str, Any]:
        return _inject_openapi(base_openapi())

    app.openapi = dbx_openapi


def list_models_payload(
    endpoints: list[dict[str, Any]],
    *,
    include_codex: bool = False,
) -> dict[str, Any]:
    available = [endpoint for endpoint in endpoints if not _deprecated(endpoint)]
    payload: dict[str, Any] = {
        "object": "list",
        "data": [_openai_model(endpoint) for endpoint in available],
    }
    if include_codex:
        models = [
            model
            for endpoint in available
            if (model := _codex_model(endpoint, priority=0)) is not None
        ]
        for priority, model in enumerate(models, start=1):
            model["priority"] = priority
        payload["models"] = models
    return payload


def _openai_model(endpoint: Mapping[str, Any]) -> dict[str, Any]:
    metadata = _mapping(endpoint.get("metadata"))
    capabilities = _mapping(metadata.get("capabilities"))
    return {
        "id": endpoint["name"],
        "object": "model",
        "created": 0,
        "owned_by": "databricks",
        "name": endpoint.get("displayName", endpoint["name"]),
        "task": endpoint.get("task"),
        "status": endpoint.get("status", {"deprecated": False}),
        "capabilities": {
            "tools": endpoint.get("supportsTools", False),
            "reasoning": endpoint.get("reasoningEfforts", []),
            **capabilities,
        },
        **({"rate_limits": metadata["rateLimits"]} if "rateLimits" in metadata else {}),
    }


def _codex_model(
    endpoint: Mapping[str, Any],
    *,
    priority: int,
) -> dict[str, Any] | None:
    model_name = _codex_model_name(endpoint)
    if model_name is None:
        return None
    efforts = [
        effort
        for effort in endpoint.get("reasoningEfforts", [])
        if isinstance(effort, str) and effort
    ]
    metadata = _mapping(endpoint.get("metadata"))
    capabilities = _mapping(metadata.get("capabilities"))
    entry: dict[str, Any] = {
        "slug": f"databricks/{model_name}",
        "display_name": endpoint.get("displayName", endpoint["name"]),
        "description": endpoint.get(
            "description",
            "Databricks Model Serving endpoint",
        ),
        "base_instructions": _CODEX_BASE_INSTRUCTIONS,
        "status": endpoint.get("status", {"deprecated": False}),
        "supported_reasoning_levels": [
            {
                "effort": effort,
                "description": _REASONING_DESCRIPTIONS.get(
                    effort,
                    f"Use the {effort} reasoning budget",
                ),
            }
            for effort in efforts
        ],
        "shell_type": "unified_exec",
        "visibility": "list",
        "supported_in_api": True,
        "priority": priority,
        "availability_nux": None,
        "upgrade": None,
        "support_verbosity": False,
        "default_verbosity": None,
        "apply_patch_tool_type": "freeform" if capabilities.get("applyPatch") else None,
        "truncation_policy": {"mode": "tokens", "limit": 128_000},
        "context_window": None,
        "experimental_supported_tools": [],
        "input_modalities": [
            "text",
            *(["image"] if capabilities.get("imageInput") else []),
        ],
        "web_search_tool_type": "text",
        "supports_search_tool": capabilities.get("webSearch") is True,
        "supports_image_detail_original": False,
    }
    if efforts:
        entry["default_reasoning_level"] = "medium" if "medium" in efforts else efforts[0]
    return entry


def _codex_model_name(endpoint: Mapping[str, Any]) -> str | None:
    if (
        endpoint.get("class") == "embedding"
        or "embedding" in str(endpoint.get("task", "")).casefold()
    ):
        return None
    family = endpoint.get("family")
    if isinstance(family, str) and family.casefold() in _CODEX_UNSUPPORTED_FAMILIES:
        return None
    service_name = endpoint.get("modelServiceName")
    if isinstance(service_name, str) and service_name.strip():
        normalized = service_name.strip().removeprefix("databricks/")
        if normalized.startswith("system.ai.databricks-"):
            return f"system.ai.{normalized.removeprefix('system.ai.databricks-')}"
        if normalized.startswith("system.ai."):
            return normalized
        if normalized.startswith("databricks-"):
            return f"system.ai.{normalized.removeprefix('databricks-')}"
    name = endpoint.get("name")
    if not isinstance(name, str) or not name.startswith("databricks-"):
        return None
    return f"system.ai.{name.removeprefix('databricks-')}"


def _deprecated(endpoint: Mapping[str, Any]) -> bool:
    status = endpoint.get("status")
    return isinstance(status, Mapping) and status.get("deprecated") is True


def _is_codex_originator(value: object) -> bool:
    return isinstance(value, str) and value.strip().casefold().startswith("codex")


def _mapping(value: object) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _disable_litellm_ui(app: Any) -> None:
    app.router.routes[:] = [
        route for route in app.router.routes if not _is_litellm_ui_path(getattr(route, "path", ""))
    ]


def _is_litellm_ui_path(path: str) -> bool:
    normalized = f"/{path.strip('/')}"
    segments = normalized.strip("/").split("/")
    return (
        normalized in {"/login", "/logout", "/onboarding"}
        or normalized.startswith(("/ui/", "/_next/", "/litellm-asset-prefix/", "/sso/"))
        or normalized == "/ui"
        or any(
            segment == "ui" or segment.startswith("ui_") or segment.endswith("_ui")
            for segment in segments
        )
        or "litellm-ui-config" in normalized
    )


def _inject_openapi(schema: dict[str, Any]) -> dict[str, Any]:
    paths = schema.setdefault("paths", {})
    for path in list(paths):
        if _is_litellm_ui_path(path):
            del paths[path]

    lookup = _mapping(_mapping(paths.get("/lookup")).get("get"))
    parameters = lookup.get("parameters")
    if not isinstance(parameters, list):
        return schema

    properties: dict[str, Any] = {}
    for parameter in parameters:
        if not isinstance(parameter, Mapping) or parameter.get("in") != "query":
            continue
        name = parameter.get("name")
        parameter_schema = parameter.get("schema")
        if not isinstance(name, str) or not isinstance(parameter_schema, Mapping):
            continue
        property_schema = deepcopy(dict(parameter_schema))
        description = parameter.get("description")
        if isinstance(description, str):
            property_schema["description"] = description
        properties[name] = property_schema

    components = schema.setdefault("components", {}).setdefault("schemas", {})
    components["DbxToolsModelLookupParameters"] = {
        "type": "object",
        "additionalProperties": False,
        "description": (
            "dbx-tools model discovery and ranking controls. Use GET /lookup before an "
            "inference request when a client needs ranked candidates rather than fuzzy model "
            "resolution alone."
        ),
        "properties": properties,
    }
    routing_extension = {
        "lookupPath": "/lookup",
        "lookupOperationId": lookup.get("operationId", "lookupDatabricksModels"),
        "parameters": {"$ref": "#/components/schemas/DbxToolsModelLookupParameters"},
    }
    for path, path_item in paths.items():
        if not path.endswith(_ROUTED_API_SUFFIXES) or not isinstance(path_item, Mapping):
            continue
        for method in ("post",):
            operation = path_item.get(method)
            if not isinstance(operation, dict):
                continue
            operation["x-dbx-tools-model-routing"] = routing_extension
            model_schema = _request_model_schema(operation)
            if model_schema is not None:
                model_schema["description"] = (
                    "Exact Databricks endpoint name or fuzzy model intent resolved through the "
                    "dbx-tools ranked workspace catalogue."
                )
                model_schema["x-dbx-tools-lookup"] = {"$ref": "#/paths/~1lookup/get"}
    schema["x-dbx-tools"] = {"modelRouting": routing_extension, "uiEnabled": False}
    return schema


def _request_model_schema(operation: Mapping[str, Any]) -> dict[str, Any] | None:
    request_body = _mapping(operation.get("requestBody"))
    content = _mapping(request_body.get("content"))
    media_type = _mapping(content.get("application/json"))
    body_schema = _mapping(media_type.get("schema"))
    properties = _mapping(body_schema.get("properties"))
    model = properties.get("model")
    return model if isinstance(model, dict) else None


def _headers(response: Response) -> dict[str, str]:
    return {
        name: value
        for name, value in response.headers.items()
        if name.lower() not in {"content-length", "content-type"}
    }


def _require_control_request(request: Request) -> None:
    client = request.client
    if client is None or client.host not in {"127.0.0.1", "::1", "localhost"}:
        raise HTTPException(status_code=403, detail="profile switching is loopback-only")
    if request.headers.get("x-model-proxy-control") != "1":
        raise HTTPException(status_code=403, detail="missing model proxy control header")
    origin = request.headers.get("origin")
    expected = f"{request.url.scheme}://{request.url.netloc}"
    if origin != expected:
        raise HTTPException(status_code=403, detail="profile switching requires same origin")
