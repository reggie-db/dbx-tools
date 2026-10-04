from __future__ import annotations

from typing import Any

import pytest
from dbx_tools.model_proxy.runtime import ModelProxyRuntime


class FakeClient:
    async def list_models(self, refresh: bool = False) -> list[dict[str, Any]]:
        assert refresh is False
        return [
            {"name": "custom-endpoint"},
            {"name": "chat-model"},
            {"name": "embedding-model"},
        ]

    async def search_models(
        self,
        query: dict[str, Any],
        refresh: bool = False,
    ) -> list[dict[str, Any]]:
        assert refresh is False
        if query.get("modelClass") == "embedding":
            return [{"endpoint": {"name": "embedding-model"}, "modelClass": "embedding"}]
        return [{"endpoint": {"name": "chat-model"}, "modelClass": "chat-fast"}]

    async def metadata(self, endpoint: dict[str, Any]) -> dict[str, Any]:
        return {
            "status": {"deprecated": False},
            "capabilities": {"responses": endpoint["name"] == "chat-model"},
        }


@pytest.mark.asyncio
async def test_models_preserve_node_ranking_then_append_custom() -> None:
    runtime = ModelProxyRuntime(FakeClient())  # type: ignore[arg-type]

    models = await runtime.models()
    assert [model["name"] for model in models] == [
        "chat-model",
        "embedding-model",
        "custom-endpoint",
    ]
    assert models[0]["metadata"]["capabilities"]["responses"] is True
