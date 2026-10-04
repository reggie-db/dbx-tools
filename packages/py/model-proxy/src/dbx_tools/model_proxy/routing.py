"""LiteLLM routing hook backed by the generated model client."""

from __future__ import annotations

from typing import Any

from litellm.integrations.custom_logger import CustomLogger

from .runtime import get_runtime

_CHAT_CALL_TYPES = frozenset({"acompletion", "completion"})
_RESPONSES_CALL_TYPES = frozenset({"aresponses", "responses"})
_EMBEDDING_CALL_TYPES = frozenset({"aembedding", "embedding"})
_CALL_TYPES = _CHAT_CALL_TYPES | _RESPONSES_CALL_TYPES | _EMBEDDING_CALL_TYPES


class DbxModelRouter(CustomLogger):
    """Resolve model intent and provide LiteLLM with Databricks routing fields."""

    async def async_pre_call_hook(
        self,
        *,
        data: dict[str, Any],
        call_type: str,
        **_: Any,
    ) -> dict[str, Any]:
        requested = data.get("model")
        if call_type not in _CALL_TYPES or not isinstance(requested, str):
            return data

        requested_protocol = "embeddings" if call_type in _EMBEDDING_CALL_TYPES else None
        tools = data.get("tools")
        route = await (await get_runtime()).route(
            _unqualified_model(requested),
            protocol=requested_protocol,
            requires_tools=isinstance(tools, list) and bool(tools),
        )
        headers = dict(route["headers"])
        token = _bearer_token(headers.pop("authorization", headers.pop("Authorization", "")))

        routed = dict(data)
        protocol = route["protocol"]
        if protocol == "responses":
            routed["model"] = (
                f"responses/{route['modelId']}"
                if call_type in _CHAT_CALL_TYPES
                else route["modelId"]
            )
            routed["custom_llm_provider"] = "openai"
        else:
            routed["model"] = f"databricks/{route['modelId']}"
            routed["custom_llm_provider"] = "databricks"
            if call_type in _RESPONSES_CALL_TYPES:
                routed["drop_params"] = True
                routed["use_chat_completions_api"] = True
        routed["api_base"] = route["apiBase"]
        routed["api_key"] = token
        if headers:
            routed["extra_headers"] = {**routed.get("extra_headers", {}), **headers}
        return routed

    async def async_pre_call_deployment_hook(
        self,
        kwargs: dict[str, Any],
        call_type: Any,
    ) -> dict[str, Any]:
        value = getattr(call_type, "value", call_type)
        return await self.async_pre_call_hook(data=kwargs, call_type=str(value or ""))


def _unqualified_model(model: str) -> str:
    return model.removeprefix("dbx/").removeprefix("databricks/").removeprefix("responses/")


def _bearer_token(value: str) -> str:
    scheme, separator, token = value.partition(" ")
    if separator and scheme.lower() == "bearer" and token.strip():
        return token.strip()
    raise RuntimeError("Generated model route did not provide a bearer token")


dbx_model_router = DbxModelRouter()
