from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import dbx_tools.litellm.routing as routing_module
import pytest
from dbx_tools.litellm.access_log import model_log_state
from dbx_tools.litellm.routing import DbxModelRouter, _uses_native_responses
from dbx_tools.model import ModelClass


class Backend:
    """Resolve test names and provide both Databricks inference bases."""

    def __init__(self) -> None:
        self.requests: list[tuple[str, bool, ModelClass | None]] = []

    def resolve(
        self,
        requested: str,
        *,
        requires_tools: bool = False,
        model_class: ModelClass | None = None,
    ) -> str:
        self.requests.append((requested, requires_tools, model_class))
        return {
            "gpt": "databricks-gpt-5-6-sol",
            "claude": "databricks-claude-sonnet-5",
            "embed": "databricks-gte-large-en",
            "detector": "custom-detector",
        }.get(requested, requested)

    def credentials(self) -> SimpleNamespace:
        return SimpleNamespace(
            token="token",
            api_base="https://workspace.example/serving-endpoints",
            codex_api_base="https://workspace.example/ai-gateway/codex/v1",
            mlflow_api_base="https://workspace.example/ai-gateway/mlflow/v1",
        )

    def reasoning_efforts(self, model_id: str) -> tuple[Any, ...]:
        del model_id
        return ()


@pytest.fixture
def backend(monkeypatch: pytest.MonkeyPatch) -> Backend:
    """Install one fake process-wide backend."""
    value = Backend()
    monkeypatch.setattr(routing_module, "get_backend", lambda: value)
    monkeypatch.setattr(
        routing_module,
        "register_streaming_support",
        lambda _model, **_: None,
    )
    monkeypatch.setattr(routing_module, "adaptive_http_handler", lambda: "client")
    return value


def codex(data: dict[str, Any]) -> dict[str, Any]:
    """Attach the Codex originator through LiteLLM's request snapshot."""
    return {
        **data,
        "proxy_server_request": {
            "headers": {
                "originator": "codex_cli_rs",
            }
        },
    }


@pytest.mark.parametrize(
    ("model", "expected"),
    [
        ("system.ai.gpt-5-6-sol", True),
        ("system.ai.gpt-oss-120b", False),
        ("system.ai.qwen35-122b-a10b", False),
        ("system.ai.meta-llama-3-3-70b-instruct", False),
    ],
)
def test_native_responses_policy(model: str, expected: bool) -> None:
    assert _uses_native_responses(model) is expected


async def test_routes_chat_through_native_databricks_provider(backend: Backend) -> None:
    data = {
        "model": "claude",
        "messages": [{"role": "user", "content": "hello"}],
        "temperature": 0.2,
    }

    routed = await DbxModelRouter().async_pre_call_hook(
        data=data,
        call_type="acompletion",
    )

    assert routed == {
        **data,
        "model": "system.ai.claude-sonnet-5",
        "custom_llm_provider": "databricks",
        "client": "client",
        "api_key": "token",
        "api_base": "https://workspace.example/ai-gateway/mlflow/v1",
    }
    assert backend.requests == [("claude", False, None)]


async def test_routes_standard_responses_without_changing_body(backend: Backend) -> None:
    data = {
        "model": "gpt",
        "input": [{"role": "user", "content": "hello"}],
        "tools": [{"type": "web_search"}],
        "tool_choice": "required",
    }

    routed = await DbxModelRouter().async_pre_call_hook(
        data=data,
        call_type="aresponses",
    )

    assert routed == {
        **data,
        "model": "system.ai.gpt-5-6-sol",
        "custom_llm_provider": "databricks",
        "client": "client",
        "api_key": "token",
        "api_base": "https://workspace.example/ai-gateway/mlflow/v1",
    }
    assert routed["input"] is data["input"]
    assert routed["tools"] is data["tools"]
    assert backend.requests == [("gpt", True, None)]


async def test_routes_codex_through_model_service_gateway(backend: Backend) -> None:
    data = codex(
        {
            "model": "databricks-gpt-5-6-sol",
            "input": "hello",
            "tools": [{"type": "web_search"}],
        }
    )

    routed = await DbxModelRouter().async_pre_call_hook(
        data=data,
        call_type="aresponses",
    )

    assert routed == {
        **data,
        "model": "system.ai.gpt-5-6-sol",
        "custom_llm_provider": "openai",
        "extra_headers": {"originator": "codex_cli_rs"},
        "client": "client",
        "api_key": "token",
        "api_base": "https://workspace.example/ai-gateway/codex/v1",
    }
    assert backend.requests == [("databricks-gpt-5-6-sol", True, None)]


async def test_bridges_codex_chat_to_native_responses(backend: Backend) -> None:
    data = codex(
        {
            "model": "gpt",
            "messages": [{"role": "user", "content": "hello"}],
        }
    )

    routed = await DbxModelRouter().async_pre_call_hook(
        data=data,
        call_type="acompletion",
    )

    assert routed["model"] == "responses/system.ai.gpt-5-6-sol"
    assert routed["custom_llm_provider"] == "openai"
    assert routed["api_base"] == "https://workspace.example/ai-gateway/codex/v1"


async def test_routes_embeddings_through_native_provider(backend: Backend) -> None:
    data = {
        "model": "embed",
        "input": ["hello"],
    }

    routed = await DbxModelRouter().async_pre_call_hook(
        data=data,
        call_type="aembedding",
    )

    assert routed == {
        **data,
        "model": "system.ai.gte-large-en",
        "custom_llm_provider": "databricks",
        "client": "client",
        "api_key": "token",
        "api_base": "https://workspace.example/ai-gateway/mlflow/v1",
    }
    assert backend.requests == [("embed", False, ModelClass.EMBEDDING)]


async def test_keeps_custom_codex_endpoints_on_model_serving(backend: Backend) -> None:
    data = codex({"model": "detector", "input": "hello"})

    routed = await DbxModelRouter().async_pre_call_hook(
        data=data,
        call_type="aresponses",
    )

    assert routed["model"] == "databricks/custom-detector"
    assert routed["api_base"] == "https://workspace.example/serving-endpoints"


async def test_routes_oss_responses_through_chat_bridge(backend: Backend) -> None:
    data = codex(
        {
            "model": "databricks/system.ai.glm-5-2",
            "input": "hello",
            "reasoning": {"effort": "medium"},
        }
    )

    routed = await DbxModelRouter().async_pre_call_hook(
        data=data,
        call_type="aresponses",
    )

    assert routed["model"] == "system.ai.glm-5-2"
    assert routed["custom_llm_provider"] == "databricks"
    assert routed["drop_params"] is True
    assert routed["use_chat_completions_api"] is True
    assert "reasoning" not in routed
    assert "reasoning_effort" not in routed
    assert routed["api_base"] == "https://workspace.example/ai-gateway/mlflow/v1"
    assert backend.requests == []


async def test_reapplies_codex_provider_after_deployment_selection(backend: Backend) -> None:
    data = codex({"model": "system.ai.qwen35-122b-a10b", "input": "hello"})

    routed = await DbxModelRouter().async_pre_call_deployment_hook(
        kwargs=data,
        call_type=SimpleNamespace(value="aresponses"),
    )

    assert routed["model"] == "system.ai.qwen35-122b-a10b"
    assert routed["custom_llm_provider"] == "databricks"
    assert routed["drop_params"] is True
    assert routed["use_chat_completions_api"] is True
    assert routed["api_base"] == "https://workspace.example/ai-gateway/mlflow/v1"


async def test_keeps_unsupported_claude_responses_on_mlflow(backend: Backend) -> None:
    data = codex({"model": "claude", "input": "hello"})

    routed = await DbxModelRouter().async_pre_call_hook(
        data=data,
        call_type="aresponses",
    )

    assert routed["model"] == "system.ai.claude-sonnet-5"
    assert routed["custom_llm_provider"] == "databricks"
    assert routed["drop_params"] is True
    assert routed["use_chat_completions_api"] is True
    assert routed["api_base"] == "https://workspace.example/ai-gateway/mlflow/v1"


async def test_records_requested_and_resolved_model_names(backend: Backend) -> None:
    data = {"model": "gpt", "litellm_call_id": "routing-model-call"}

    await DbxModelRouter().async_pre_call_hook(
        data=data,
        call_type="acompletion",
    )

    state = model_log_state(data)
    assert state is not None
    assert state.requested == "gpt"
    assert state.resolved == "databricks-gpt-5-6-sol"
