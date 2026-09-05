"""LiteLLM proxy routing hooks for native Databricks Responses calls."""

from __future__ import annotations

import asyncio
from typing import Any

from litellm.integrations.custom_logger import CustomLogger

from .access_log import record_model_log_state
from .models import register_streaming_support, requires_responses_api
from .provider import dbx_provider

_CHAT_CALL_TYPES = frozenset({"acompletion", "completion"})
_RESPONSES_CALL_TYPES = frozenset({"aresponses", "responses"})
_CALL_TYPES = _CHAT_CALL_TYPES | _RESPONSES_CALL_TYPES


class DbxResponsesRouter(CustomLogger):
    """Resolve and normalize Responses models before provider selection."""

    async def async_pre_call_hook(
        self,
        *,
        data: dict[str, Any],
        call_type: str,
        **_: Any,
    ) -> dict[str, Any]:
        model = data.get("model")
        if call_type not in _CALL_TYPES or not isinstance(model, str):
            return data

        routed = dict(data)
        if call_type in _CHAT_CALL_TYPES and model.startswith("databricks/"):
            resolved = model.removeprefix("databricks/").removeprefix("responses/")
            record_model_log_state(data, requested=model, resolved=resolved)
            register_streaming_support(resolved)
            if requires_responses_api(resolved):
                routed["model"] = f"databricks/responses/{resolved}"
                return await _with_credentials(routed)
            return data

        if model.startswith("databricks/"):
            # An already-qualified model skips resolution, so declare its
            # streaming support here instead.
            register_streaming_support(model)
            resolved = model.removeprefix("databricks/").removeprefix("responses/")
        else:
            tools = data.get("tools")
            resolved = await asyncio.to_thread(
                dbx_provider.backend.resolve,
                model,
                requires_tools=isinstance(tools, list) and bool(tools),
            )
            routed["model"] = (
                f"databricks/{resolved}" if requires_responses_api(resolved) else resolved
            )

        record_model_log_state(data, requested=model, resolved=resolved)
        return await _with_credentials(routed)


async def _with_credentials(data: dict[str, Any]) -> dict[str, Any]:
    """Supply an explicit token so LiteLLM skips its per-request SDK auth.

    LiteLLM builds a fresh WorkspaceClient on every Databricks request, minting
    a new one-hour token each time. Passing api_key/api_base keeps it on the
    branch that uses a caller-supplied key as-is.
    """
    if data.get("api_key") or data.get("api_base"):
        return data

    credentials = await asyncio.to_thread(dbx_provider.backend.credentials)
    data["api_key"] = credentials.token
    data["api_base"] = credentials.api_base
    return data


dbx_responses_router = DbxResponsesRouter()
