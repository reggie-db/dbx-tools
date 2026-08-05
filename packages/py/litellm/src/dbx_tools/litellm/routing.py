"""LiteLLM proxy routing hooks for native Databricks Responses calls."""

from __future__ import annotations

import asyncio
from typing import Any

from litellm.integrations.custom_logger import CustomLogger

from .models import requires_responses_api
from .provider import dbx_provider

_RESPONSES_CALL_TYPES = frozenset({"aresponses", "responses"})


class DbxResponsesRouter(CustomLogger):
    """Resolve Responses-only models before LiteLLM selects a provider."""

    async def async_pre_call_hook(
        self,
        *,
        data: dict[str, Any],
        call_type: str,
        **_: Any,
    ) -> dict[str, Any]:
        model = data.get("model")
        if (
            call_type not in _RESPONSES_CALL_TYPES
            or not isinstance(model, str)
            or model.startswith("databricks/")
        ):
            return data

        tools = data.get("tools")
        resolved = await asyncio.to_thread(
            dbx_provider.backend.resolve,
            model,
            requires_tools=isinstance(tools, list) and bool(tools),
        )
        routed = dict(data)
        routed["model"] = (
            f"databricks/{resolved}" if requires_responses_api(resolved) else resolved
        )
        return routed


dbx_responses_router = DbxResponsesRouter()
