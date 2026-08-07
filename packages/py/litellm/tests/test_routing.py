from __future__ import annotations

from typing import Any

import dbx_tools.litellm.routing as routing_module
import pytest
from dbx_tools.litellm.routing import DbxResponsesRouter


@pytest.fixture(autouse=True)
def _credentials(monkeypatch: pytest.MonkeyPatch) -> None:
    async def with_credentials(data: dict[str, Any]) -> dict[str, Any]:
        return {**data, "api_key": "token", "api_base": "https://example.com"}

    monkeypatch.setattr(routing_module, "_with_credentials", with_credentials)
    monkeypatch.setattr(routing_module, "register_streaming_support", lambda _model: None)


async def test_routes_qualified_new_gpt_chat_calls_through_responses() -> None:
    data = {
        "model": "databricks/databricks-gpt-5-6-sol",
        "reasoning_effort": "medium",
        "tools": [{"type": "function", "function": {"name": "queue_status"}}],
        "stream": True,
    }

    routed = await DbxResponsesRouter().async_pre_call_hook(
        data=data,
        call_type="acompletion",
    )

    assert routed == {
        **data,
        "model": "databricks/responses/databricks-gpt-5-6-sol",
        "api_key": "token",
        "api_base": "https://example.com",
    }


async def test_keeps_chat_capable_qualified_models_on_chat_completions() -> None:
    data = {
        "model": "databricks/databricks-gpt-5-1",
        "reasoning_effort": "medium",
        "tools": [{"type": "function", "function": {"name": "queue_status"}}],
    }

    routed = await DbxResponsesRouter().async_pre_call_hook(
        data=data,
        call_type="completion",
    )

    assert routed is data
