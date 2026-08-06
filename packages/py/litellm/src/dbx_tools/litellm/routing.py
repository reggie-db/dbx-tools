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
        if call_type not in _RESPONSES_CALL_TYPES or not isinstance(model, str):
            return data

        routed = dict(data)
        if not model.startswith("databricks/"):
            tools = data.get("tools")
            resolved = await asyncio.to_thread(
                dbx_provider.backend.resolve,
                model,
                requires_tools=isinstance(tools, list) and bool(tools),
            )
            routed["model"] = (
                f"databricks/{resolved}" if requires_responses_api(resolved) else resolved
            )

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
