"""Model-only routing from live Databricks names to LiteLLM's native provider."""

from __future__ import annotations

import asyncio
from typing import Any

from dbx_tools.model import ModelClass
from dbx_tools.model.models import ModelFamily, parse_model_name

from litellm.integrations.custom_logger import CustomLogger

from .access_log import model_log_state, record_model_log_state
from .backend import codex_gateway_model_name, gateway_model_name, get_backend
from .capabilities import adaptive_http_handler
from .models import register_streaming_support
from .originator import forward_codex_originator, is_codex_request

_CHAT_CALL_TYPES = frozenset({"acompletion", "completion"})
_RESPONSES_CALL_TYPES = frozenset({"aresponses", "responses"})
_EMBEDDING_CALL_TYPES = frozenset({"aembedding", "embedding"})
_CALL_TYPES = _CHAT_CALL_TYPES | _RESPONSES_CALL_TYPES | _EMBEDDING_CALL_TYPES


class DbxModelRouter(CustomLogger):
    """Resolve live models and select LiteLLM's native Databricks transport."""

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

        model = _unqualified_model(requested)
        backend = get_backend()
        tools = data.get("tools")
        resolved = (
            model
            if model.startswith("system.ai.")
            else await asyncio.to_thread(
                backend.resolve,
                model,
                requires_tools=isinstance(tools, list) and bool(tools),
                model_class=(ModelClass.EMBEDDING if call_type in _EMBEDDING_CALL_TYPES else None),
            )
        )
        if model_log_state(data) is None:
            record_model_log_state(data, requested=requested, resolved=resolved)

        codex = is_codex_request(data)
        model_service = gateway_model_name(resolved)
        codex_model = codex_gateway_model_name(resolved) if codex else None
        native_responses = _uses_native_responses(resolved)
        codex_route = (
            native_responses
            and codex_model is not None
            and call_type in (_CHAT_CALL_TYPES | _RESPONSES_CALL_TYPES)
        )
        chat_bridge = (
            model_service is not None
            and call_type in _RESPONSES_CALL_TYPES
            and not native_responses
        )
        target = model_service or resolved

        routed = dict(data)
        if codex_route:
            routed["model"] = (
                f"responses/{codex_model}" if call_type in _CHAT_CALL_TYPES else codex_model
            )
            routed["custom_llm_provider"] = "openai"
        elif model_service is not None:
            routed["model"] = model_service
            routed["custom_llm_provider"] = "databricks"
            if chat_bridge:
                routed["drop_params"] = True
                routed["use_chat_completions_api"] = True
                if not await asyncio.to_thread(backend.reasoning_efforts, resolved):
                    routed.pop("reasoning", None)
                    routed.pop("reasoning_effort", None)
        else:
            routed["model"] = f"databricks/{target}"
        if not codex_route and call_type not in _EMBEDDING_CALL_TYPES:
            register_streaming_support(
                target,
                responses=call_type in _RESPONSES_CALL_TYPES,
            )
        if codex:
            forward_codex_originator(routed)
        routed["client"] = adaptive_http_handler()
        if not routed.get("api_key") and not routed.get("api_base"):
            credentials = await asyncio.to_thread(backend.credentials)
            routed["api_key"] = credentials.token
            if codex_route:
                routed["api_base"] = credentials.codex_api_base
            elif model_service is not None:
                routed["api_base"] = credentials.mlflow_api_base
            else:
                routed["api_base"] = credentials.api_base
        return routed

    async def async_pre_call_deployment_hook(
        self,
        kwargs: dict[str, Any],
        call_type: Any,
    ) -> dict[str, Any]:
        """Reapply routing fields after LiteLLM selects the wildcard deployment."""
        value = getattr(call_type, "value", call_type)
        return await self.async_pre_call_hook(
            data=kwargs,
            call_type=str(value) if value is not None else "",
        )


def _unqualified_model(model: str) -> str:
    return model.removeprefix("dbx/").removeprefix("databricks/").removeprefix("responses/")


def _uses_native_responses(model: str) -> bool:
    parsed = parse_model_name(model)
    return parsed is not None and parsed.family == ModelFamily.GPT and "oss" not in parsed.model


dbx_model_router = DbxModelRouter()
