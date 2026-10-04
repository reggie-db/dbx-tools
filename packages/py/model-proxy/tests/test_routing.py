from __future__ import annotations

from typing import Any

import pytest
from dbx_tools.model_proxy import routing


class FakeRuntime:
    async def route(self, requested: str, **options: Any) -> dict[str, Any]:
        assert requested == "gpt"
        assert options == {"protocol": None, "requires_tools": True}
        return {
            "modelId": "databricks-gpt-5-4",
            "protocol": "responses",
            "apiBase": "https://workspace.example.com/serving-endpoints",
            "headers": {
                "authorization": "Bearer token",
                "x-databricks-workspace-id": "123",
            },
        }


@pytest.mark.asyncio
async def test_router_uses_generated_route(monkeypatch: pytest.MonkeyPatch) -> None:
    async def runtime() -> FakeRuntime:
        return FakeRuntime()

    monkeypatch.setattr(routing, "get_runtime", runtime)
    routed = await routing.DbxModelRouter().async_pre_call_hook(
        data={"model": "databricks/gpt", "tools": [{"type": "function"}]},
        call_type="responses",
    )

    assert routed["model"] == "databricks-gpt-5-4"
    assert routed["custom_llm_provider"] == "openai"
    assert routed["api_key"] == "token"
    assert routed["extra_headers"] == {"x-databricks-workspace-id": "123"}


def test_bearer_token_fails_fast() -> None:
    with pytest.raises(RuntimeError, match="bearer token"):
        routing._bearer_token("token")
