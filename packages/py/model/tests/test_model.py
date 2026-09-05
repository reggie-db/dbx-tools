from __future__ import annotations

import json
import threading
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from urllib.request import Request

import pytest
from dbx_tools.model import (
    ModelClass,
    ModelService,
    ModelStatus,
    ReasoningEffort,
    ServingEndpointSummary,
    auth_headers,
    extract_embedding,
    invocations_url,
    list_serving_endpoints,
    lookup_models,
    post_json,
    rank_model_id,
    reasoning_efforts_by_family,
    repair_trailing_assistant_messages,
    resolve_model,
)
from typing_extensions import Self


class FakeServingEndpoints:
    def list(self) -> list[object]:
        return [
            SimpleNamespace(
                name="databricks-claude-sonnet-4-6",
                task="llm/v1/chat",
                state=SimpleNamespace(ready="READY"),
                description="Balanced chat",
                tags=[],
                config=SimpleNamespace(
                    served_entities=[
                        SimpleNamespace(
                            entity_name="system.ai.claude-sonnet-4-6",
                            foundation_model=SimpleNamespace(
                                name="system.ai.claude-sonnet-4-6",
                                ai_gateway_model_profile=SimpleNamespace(
                                    quality=5, speed=4, cost=3
                                ),
                            ),
                            external_model=None,
                        )
                    ]
                ),
            ),
            SimpleNamespace(
                name="databricks-claude-haiku-4-5",
                task="llm/v1/chat",
                state=None,
                description=None,
                tags=[],
                config=SimpleNamespace(served_entities=[]),
            ),
            SimpleNamespace(
                name="reasoning-primary",
                task="llm/v1/chat",
                state=None,
                description=None,
                tags=[],
                config=SimpleNamespace(
                    served_entities=[
                        SimpleNamespace(
                            entity_name="system.ai.gpt-5-6-sol",
                            foundation_model=None,
                            external_model=None,
                        )
                    ]
                ),
            ),
        ]


class FakeConfig:
    def authenticate(self) -> dict[str, str]:
        return {"Authorization": "Bearer token"}


class FakeResponse:
    def __enter__(self) -> Self:
        return self

    def __exit__(self, *args: object) -> None:
        return None

    def read(self) -> bytes:
        return b'{"ok":true}'


@pytest.fixture(autouse=True)
def _disable_retired_model_refresh(monkeypatch) -> None:
    monkeypatch.setattr("dbx_tools.model.serving.model_status.retired_model_names", frozenset)


def test_list_serving_endpoints_returns_stable_models() -> None:
    client = SimpleNamespace(serving_endpoints=FakeServingEndpoints())

    endpoints = list_serving_endpoints(client)

    assert endpoints[0].profile is not None
    assert endpoints[0].profile.quality == 5
    assert endpoints[0].model_class == ModelClass.CHAT_THINKING
    assert endpoints[0].reasoning_efforts == (
        ReasoningEffort.NONE,
        ReasoningEffort.MINIMAL,
        ReasoningEffort.LOW,
        ReasoningEffort.MEDIUM,
        ReasoningEffort.HIGH,
        ReasoningEffort.XHIGH,
        ReasoningEffort.MAX,
    )
    assert endpoints[0].service_names == {ModelService.ANTHROPIC: "claude-sonnet-4-6"}
    assert endpoints[1].model_class == ModelClass.CHAT_FAST
    custom = next(endpoint for endpoint in endpoints if endpoint.name == "reasoning-primary")
    assert custom.reasoning_efforts[-1] == ReasoningEffort.MAX
    assert custom.service_names == {ModelService.OPENAI: "gpt-5.6-sol"}


def test_list_serving_endpoints_excludes_retired_entity(monkeypatch) -> None:
    client = SimpleNamespace(
        serving_endpoints=SimpleNamespace(
            list=lambda: [
                SimpleNamespace(
                    name="legacy-model",
                    task="llm/v1/chat",
                    state=None,
                    description=None,
                    tags=[],
                    config=SimpleNamespace(
                        served_entities=[
                            SimpleNamespace(
                                entity_name="system.ai.gemini-2-5-pro",
                                foundation_model=None,
                                external_model=None,
                            )
                        ]
                    ),
                )
            ]
        )
    )
    monkeypatch.setattr(
        "dbx_tools.model.serving.model_status.retired_model_names",
        lambda: frozenset({"Gemini 2.5 Pro"}),
    )

    assert list_serving_endpoints(client) == []
    endpoints = list_serving_endpoints(client, include_deprecated=True)
    assert len(endpoints) == 1
    assert endpoints[0].name == "legacy-model"
    assert endpoints[0].status.deprecated is True


def test_reasoning_efforts_are_inferred_from_family_and_served_entity() -> None:
    assert reasoning_efforts_by_family("databricks-gpt-5-5") == (
        ReasoningEffort.LOW,
        ReasoningEffort.MEDIUM,
        ReasoningEffort.HIGH,
    )
    assert reasoning_efforts_by_family("system.ai.gpt-5-6-sol") == (
        ReasoningEffort.NONE,
        ReasoningEffort.LOW,
        ReasoningEffort.MEDIUM,
        ReasoningEffort.HIGH,
        ReasoningEffort.XHIGH,
        ReasoningEffort.MAX,
    )
    assert reasoning_efforts_by_family("databricks-gpt-5-5-pro") == (
        ReasoningEffort.MEDIUM,
        ReasoningEffort.HIGH,
        ReasoningEffort.XHIGH,
    )
    assert reasoning_efforts_by_family("databricks-claude-sonnet-5") == (
        ReasoningEffort.NONE,
        ReasoningEffort.MINIMAL,
        ReasoningEffort.LOW,
        ReasoningEffort.MEDIUM,
        ReasoningEffort.HIGH,
        ReasoningEffort.XHIGH,
        ReasoningEffort.MAX,
    )
    assert reasoning_efforts_by_family("databricks-gemini-3-5-flash") == (
        ReasoningEffort.MINIMAL,
        ReasoningEffort.LOW,
        ReasoningEffort.MEDIUM,
        ReasoningEffort.HIGH,
    )
    assert reasoning_efforts_by_family("databricks-gpt-6") == (
        ReasoningEffort.LOW,
        ReasoningEffort.MEDIUM,
        ReasoningEffort.HIGH,
    )
    assert reasoning_efforts_by_family("databricks-meta-llama-3-1-8b-instruct") == ()


def test_post_json_authenticates_each_request() -> None:
    captured: list[Request] = []

    def opener(request: Request, *, timeout: float | None) -> FakeResponse:
        assert timeout == 5
        captured.append(request)
        return FakeResponse()

    response = post_json(
        SimpleNamespace(config=FakeConfig()),
        invocations_url("https://workspace.example.com/", "model/name"),
        {"messages": []},
        timeout=5,
        opener=opener,
    )

    assert response == {"ok": True}
    assert captured[0].get_header("Authorization") == "Bearer token"
    assert json.loads(captured[0].data or b"") == {"messages": []}


def test_concurrent_auth_headers_share_one_sdk_authentication() -> None:
    started = threading.Event()
    release = threading.Event()
    second_entered = threading.Event()

    class SlowConfig:
        authenticate_count = 0

        def authenticate(self) -> dict[str, str]:
            self.authenticate_count += 1
            started.set()
            assert release.wait(timeout=5)
            return {"Authorization": "Bearer token"}

    config = SlowConfig()
    client = SimpleNamespace(config=config)

    def second_read() -> dict[str, str]:
        second_entered.set()
        return auth_headers(client)

    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(auth_headers, client)
        assert started.wait(timeout=5)
        second = executor.submit(second_read)
        assert second_entered.wait(timeout=5)
        release.set()

    assert first.result() == {"Authorization": "Bearer token"}
    assert second.result() == {"Authorization": "Bearer token"}
    assert config.authenticate_count == 1


def test_resolve_model_fuzzy_name_and_embedding_dimension() -> None:
    endpoints = list_serving_endpoints(SimpleNamespace(serving_endpoints=FakeServingEndpoints()))

    selection = resolve_model(endpoints, explicit="claude sonnet")

    assert selection.model_id == "databricks-claude-sonnet-4-6"
    assert extract_embedding({"data": [{"embedding": [1, 2, 3]}]}, 3) == [1.0, 2.0, 3.0]
    with pytest.raises(ValueError, match="Expected embedding dimension 2"):
        extract_embedding({"data": [{"embedding": [1, 2, 3]}]}, 2)


def test_lookup_models_can_include_deprecated_models() -> None:
    endpoints = [
        ServingEndpointSummary(
            name="databricks-gemini-3-1-pro",
            task="llm/v1/chat",
            modelClass=ModelClass.CHAT_BALANCED,
        ),
        ServingEndpointSummary(
            name="databricks-gemini-2-5-pro",
            task="llm/v1/chat",
            modelClass=ModelClass.CHAT_BALANCED,
            status=ModelStatus(deprecated=True),
        ),
    ]

    current = lookup_models(endpoints)
    including_deprecated = lookup_models(endpoints, {"includeDeprecated": True})

    assert [item["endpoint"]["name"] for item in current] == ["databricks-gemini-3-1-pro"]
    assert [item["endpoint"]["name"] for item in including_deprecated] == [
        "databricks-gemini-3-1-pro",
        "databricks-gemini-2-5-pro",
    ]


def test_repair_trailing_assistant_messages_preserves_valid_tool_results() -> None:
    messages = [
        {"role": "user", "content": "run it"},
        {"role": "assistant", "tool_calls": [{"id": "call-1"}]},
        {"role": "tool", "tool_call_id": "call-1", "content": "done"},
    ]

    assert repair_trailing_assistant_messages(messages) is messages
    unanswered_tool_call = messages[:2]
    assert repair_trailing_assistant_messages(unanswered_tool_call) is unanswered_tool_call
    assert (
        repair_trailing_assistant_messages([*messages, {"role": "assistant", "content": "partial"}])
        == messages
    )
    all_assistant = [{"role": "assistant", "content": "partial"}]
    assert repair_trailing_assistant_messages(all_assistant) is all_assistant


def test_rank_model_id_preserves_an_exact_embedding_endpoint() -> None:
    endpoints = [
        ServingEndpointSummary(
            name="databricks-gte-large-en",
            task="llm/v1/embeddings",
            modelClass=ModelClass.EMBEDDING,
        ),
        ServingEndpointSummary(
            name="databricks-qwen3-next",
            task="llm/v1/chat",
            modelClass=ModelClass.CHAT_BALANCED,
        ),
    ]

    resolved = rank_model_id(endpoints, "databricks-gte-large-en")

    assert resolved.model_id == "databricks-gte-large-en"
    assert resolved.matched is True
