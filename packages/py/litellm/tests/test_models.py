from __future__ import annotations

import litellm
import pytest
from dbx_tools.litellm import models
from dbx_tools.litellm.models import register_streaming_support, requires_responses_api
from litellm.llms.databricks.responses.transformation import DatabricksResponsesAPIConfig


@pytest.fixture(autouse=True)
def _clear_registry() -> None:
    models._registered.clear()


@pytest.mark.parametrize(
    ("model", "expected"),
    [
        ("databricks-gpt-5-5-pro", True),
        ("codex-mini", True),
        ("databricks-claude-sonnet-4-5", False),
        ("databricks-gpt-5-mini", False),
    ],
)
def test_requires_responses_api(model: str, expected: bool) -> None:
    assert requires_responses_api(model) is expected


def test_registration_marks_model_as_natively_streamable() -> None:
    # Unregistered Databricks endpoints are absent from LiteLLM's cost map, and
    # the lookup failure is read as "cannot stream", which buffers the whole
    # response before any event is emitted.
    config = DatabricksResponsesAPIConfig()
    model = "databricks/databricks-gpt-5-5-pro"

    register_streaming_support("databricks-gpt-5-5-pro")

    assert (
        config.should_fake_stream(model=model, stream=True, custom_llm_provider="databricks")
        is False
    )
    assert litellm.utils.supports_native_streaming(model=model, custom_llm_provider="databricks")


def test_registration_accepts_an_already_qualified_model() -> None:
    register_streaming_support("databricks/databricks-gpt-5-5-pro")

    assert "databricks/databricks-gpt-5-5-pro" in models._registered


def test_registration_is_idempotent(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict[str, object]] = []
    monkeypatch.setattr(litellm, "register_model", lambda payload: calls.append(payload))

    for _ in range(3):
        register_streaming_support("databricks-gpt-5-5-pro")

    assert len(calls) == 1


def test_registered_mode_follows_the_endpoint_api(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict[str, object]] = []
    monkeypatch.setattr(litellm, "register_model", lambda payload: calls.append(payload))

    register_streaming_support("databricks-gpt-5-5-pro")
    register_streaming_support("databricks-claude-sonnet-4-5")

    modes = {model: info["mode"] for payload in calls for model, info in payload.items()}
    assert modes == {
        "databricks/databricks-gpt-5-5-pro": "responses",
        "databricks/databricks-claude-sonnet-4-5": "chat",
    }
