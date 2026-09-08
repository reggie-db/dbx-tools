from __future__ import annotations

import time
from collections.abc import Callable
from types import SimpleNamespace

import dbx_tools.litellm.backend as backend_module
import pytest
from cachetools import TTLCache
from dbx_tools.litellm.backend import (
    DEFAULT_MODEL_CACHE_TTL_SECONDS,
    DatabricksLiteLLMBackend,
    codex_gateway_model_name,
)
from dbx_tools.model import ModelClass, ReasoningEffort, ServingEndpointSummary


def _backend(
    timer: Callable[[], float] = time.monotonic,
) -> DatabricksLiteLLMBackend:
    backend = object.__new__(DatabricksLiteLLMBackend)
    backend.profile = None
    backend.threshold = backend_module.DEFAULT_FUZZY_THRESHOLD
    backend.cache_ttl_seconds = DEFAULT_MODEL_CACHE_TTL_SECONDS
    backend._credentials = SimpleNamespace(client=lambda: SimpleNamespace())
    backend._catalogue_cache = TTLCache(
        maxsize=1,
        ttl=backend.cache_ttl_seconds,
        timer=timer,
    )
    return backend


@pytest.mark.parametrize(
    ("model", "expected"),
    [
        ("databricks-kimi-k3", "system.ai.kimi-k3"),
        ("databricks-glm-5-2", "system.ai.glm-5-2"),
        ("databricks-grok-4", "system.ai.grok-4"),
        ("databricks-claude-opus-5", None),
        ("databricks-gemini-3-1-pro", None),
        ("databricks-qwen3-embedding-0-6b", None),
    ],
)
def test_codex_model_policy_is_exclusion_based(model: str, expected: str | None) -> None:
    assert codex_gateway_model_name(model) == expected


def test_catalogue_uses_the_model_cache_ttl(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = 100.0
    calls = 0

    def monotonic() -> float:
        return now

    def list_endpoints(
        _: object,
        *,
        include_deprecated: bool = False,
    ) -> list[ServingEndpointSummary]:
        nonlocal calls
        assert include_deprecated is True
        calls += 1
        version = "5-6-sol" if calls == 1 else "5-6-terra"
        return [ServingEndpointSummary(name=f"databricks-gpt-{version}")]

    monkeypatch.setattr(backend_module, "list_serving_endpoints", list_endpoints)
    backend = _backend(monotonic)

    catalogue = backend.catalogue()

    assert [model.name for model in catalogue.endpoints] == ["databricks-gpt-5-6-sol"]
    assert calls == 1

    now += DEFAULT_MODEL_CACHE_TTL_SECONDS - 1
    assert backend.models()[0].name == "databricks-gpt-5-6-sol"
    assert calls == 1

    now += 2
    catalogue = backend.catalogue()
    assert [model.name for model in catalogue.endpoints] == ["databricks-gpt-5-6-terra"]
    assert calls == 2


def test_reasoning_efforts_use_cached_endpoint_metadata(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        backend_module,
        "list_serving_endpoints",
        lambda _, *, include_deprecated=False: [
            ServingEndpointSummary(
                name="databricks-gpt-5-6-sol",
                reasoningEfforts=[ReasoningEffort.MEDIUM],
            )
        ],
    )
    backend = _backend()

    assert backend.reasoning_efforts("system.ai.gpt-5-6-sol") == (ReasoningEffort.MEDIUM,)
    assert backend.reasoning_efforts("system.ai.llama-4-maverick") == ()


def test_resolve_uses_provider_neutral_model_parsing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        backend_module,
        "list_serving_endpoints",
        lambda _, *, include_deprecated=False: [
            ServingEndpointSummary(
                name="databricks-qwen35-122b-a10b",
                task="llm/v1/chat",
            )
        ],
    )
    backend = _backend()

    assert backend.resolve(" qwen3.5-122b-a10b ") == "databricks-qwen35-122b-a10b"


def test_resolve_falls_back_within_requested_model_class(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        backend_module,
        "list_serving_endpoints",
        lambda _, *, include_deprecated=False: [
            ServingEndpointSummary(
                name="databricks-gte-large-en",
                model_class=ModelClass.EMBEDDING,
                task="llm/v1/embeddings",
            ),
            ServingEndpointSummary(
                name="databricks-gpt-5-6-sol",
                model_class=ModelClass.CHAT_BALANCED,
                task="llm/v1/chat",
            ),
        ],
    )
    backend = _backend()

    assert backend.resolve("gte", model_class=ModelClass.EMBEDDING) == "databricks-gte-large-en"


def test_model_cache_can_be_forced_before_expiry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = 0

    def list_endpoints(
        _: object,
        *,
        include_deprecated: bool = False,
    ) -> list[ServingEndpointSummary]:
        nonlocal calls
        assert include_deprecated is True
        calls += 1
        return [ServingEndpointSummary(name=f"custom-{calls}")]

    monkeypatch.setattr(backend_module, "list_serving_endpoints", list_endpoints)
    backend = _backend()

    assert backend.models()[0].name == "custom-1"
    assert backend.models(force=True)[0].name == "custom-2"
    assert calls == 2
