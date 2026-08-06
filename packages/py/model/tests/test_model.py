from __future__ import annotations

import json
from types import SimpleNamespace
from urllib.request import Request

import pytest
from dbx_tools.model import (
    ModelClass,
    ReasoningEffort,
    extract_embedding,
    invocations_url,
    list_serving_endpoints,
    post_json,
    reasoning_efforts_by_family,
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


def test_list_serving_endpoints_returns_stable_models() -> None:
    client = SimpleNamespace(serving_endpoints=FakeServingEndpoints())

    endpoints = list_serving_endpoints(client)

    assert endpoints[0].display_name == "Claude Sonnet 4.6"
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
    assert endpoints[1].model_class == ModelClass.CHAT_FAST
    custom = next(endpoint for endpoint in endpoints if endpoint.name == "reasoning-primary")
    assert custom.reasoning_efforts[-1] == ReasoningEffort.MAX


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
    assert captured[0].full_url.endswith("model%2Fname/invocations")


def test_resolve_model_fuzzy_name_and_embedding_dimension() -> None:
    endpoints = list_serving_endpoints(SimpleNamespace(serving_endpoints=FakeServingEndpoints()))

    selection = resolve_model(endpoints, explicit="claude sonnet")

    assert selection.model_id == "databricks-claude-sonnet-4-6"
    assert extract_embedding({"data": [{"embedding": [1, 2, 3]}]}, 3) == [1.0, 2.0, 3.0]
    with pytest.raises(ValueError, match="Expected embedding dimension 2"):
        extract_embedding({"data": [{"embedding": [1, 2, 3]}]}, 2)
