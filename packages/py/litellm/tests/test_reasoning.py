from __future__ import annotations

import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import dbx_tools.litellm.reasoning as reasoning_module
import pytest
from dbx_tools.litellm.access_log import reasoning_log_state
from dbx_tools.litellm.reasoning import DbxAutoReasoning, ReasoningCache
from dbx_tools.litellm.reasoning import _effort_for_score as effort_for_score
from dbx_tools.litellm.reasoning import _parse_score as parse_score
from dbx_tools.model import ReasoningEffort, reasoning_efforts_by_family
from litellm.llms.databricks.chat.transformation import DatabricksConfig


class StubAutoReasoning(DbxAutoReasoning):
    def __init__(self, cache: ReasoningCache, scores: list[float | None]) -> None:
        super().__init__(cache)
        self.scores = scores
        self.samples: list[str] = []

    async def _classify_score(self, sample: str):
        self.samples.append(sample)
        return self.scores.pop(0)

    async def _reasoning_efforts(self, model: str) -> tuple[ReasoningEffort, ...]:
        return reasoning_efforts_by_family(model)


async def test_classifier_resolves_default_model_from_live_discovery(
    cache: ReasoningCache,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Backend:
        requested: str | None = None

        def resolve(self, requested: str) -> str:
            self.requested = requested
            return "databricks-meta-llama-3-3-70b-instruct"

        def credentials(self) -> SimpleNamespace:
            return SimpleNamespace(token="token", api_base="https://workspace.example.com")

    backend = Backend()
    completion = AsyncMock(
        return_value={"choices": [{"message": {"content": "0.5"}}]},
    )
    monkeypatch.delenv(reasoning_module.REASONING_MODEL_ENV, raising=False)
    monkeypatch.setattr(reasoning_module.dbx_provider, "_backend", backend)
    monkeypatch.setattr(reasoning_module.litellm, "acompletion", completion)

    score = await DbxAutoReasoning(cache)._classify_score("USER: compare these designs")

    assert score == 0.5
    assert backend.requested == reasoning_module.DEFAULT_REASONING_MODEL
    assert completion.await_args.kwargs["model"] == (
        "databricks/databricks-meta-llama-3-3-70b-instruct"
    )
    assert completion.await_args.kwargs["reasoning_effort"] == "none"


@pytest.fixture
def cache(tmp_path: Path) -> ReasoningCache:
    return ReasoningCache(tmp_path, ttl_seconds=60)


async def test_chat_auto_effort_is_classified(cache: ReasoningCache) -> None:
    reasoner = StubAutoReasoning(cache, [0.5])
    data = {
        "model": "databricks/databricks-gpt-5-2",
        "messages": [{"role": "user", "content": "Refactor this parser"}],
        "reasoning_effort": "auto",
    }

    routed = await reasoner.async_pre_call_hook(data=data, call_type="acompletion")

    assert routed["reasoning_effort"] == "medium"
    assert reasoner.samples == ["USER: Refactor this parser"]


async def test_auto_effort_records_requested_and_selected_levels(cache: ReasoningCache) -> None:
    reasoner = StubAutoReasoning(cache, [0.5])
    data = {
        "model": "databricks/databricks-gpt-5-2",
        "messages": [{"role": "user", "content": "Compare these designs"}],
        "reasoning_effort": "auto",
        "litellm_call_id": "auto-log-call",
    }

    await reasoner.async_pre_call_hook(data=data, call_type="acompletion")

    state = reasoning_log_state({"litellm_call_id": "auto-log-call"})
    assert state is not None
    assert state.requested == "auto"
    assert state.selected == "medium"


async def test_explicit_effort_maps_without_auto_metrics(cache: ReasoningCache) -> None:
    reasoner = StubAutoReasoning(cache, [])
    data = {
        "model": "databricks/databricks-gpt-5-2",
        "messages": [{"role": "user", "content": "Compare these designs"}],
        "reasoning_effort": "high",
        "litellm_call_id": "explicit-log-call",
    }

    routed = await reasoner.async_pre_call_hook(data=data, call_type="acompletion")

    assert routed is not data
    assert routed["reasoning_effort"] == "high"
    assert reasoner.samples == []
    assert reasoning_log_state({"litellm_call_id": "explicit-log-call"}) is None


async def test_default_effort_is_not_invoked_or_measured(cache: ReasoningCache) -> None:
    reasoner = StubAutoReasoning(cache, [])
    data = {
        "model": "databricks/databricks-gpt-5-2",
        "messages": [{"role": "user", "content": "Say hello"}],
        "litellm_call_id": "default-log-call",
    }

    routed = await reasoner.async_pre_call_hook(data=data, call_type="acompletion")

    assert routed is data
    assert reasoner.samples == []
    assert reasoning_log_state({"litellm_call_id": "default-log-call"}) is None


async def test_responses_auto_effort_uses_responses_shape(cache: ReasoningCache) -> None:
    reasoner = StubAutoReasoning(cache, [0.8])
    data = {
        "model": "databricks/databricks-gpt-5-1-codex-max",
        "input": "Debug the deadlock across these services",
        "reasoning": {"effort": "auto"},
    }

    routed = await reasoner.async_pre_call_hook(data=data, call_type="aresponses")

    assert routed["reasoning"] == {"effort": "high"}
    assert "reasoning_effort" not in routed


async def test_responses_auto_preserves_reasoning_summary(cache: ReasoningCache) -> None:
    reasoner = StubAutoReasoning(cache, [0.5])
    data = {
        "model": "databricks/databricks-gpt-5-2",
        "input": "Compare these designs",
        "reasoning": {"effort": "auto", "summary": "concise"},
    }

    routed = await reasoner.async_pre_call_hook(data=data, call_type="aresponses")

    assert routed["reasoning"] == {"effort": "medium", "summary": "concise"}


@pytest.mark.parametrize("selector", [0.5, "0.5", 50, "50", "50%"])
async def test_chat_numeric_selector_uses_shared_score_mapping(
    cache: ReasoningCache, selector: object
) -> None:
    reasoner = StubAutoReasoning(cache, [])
    data = {
        "model": "databricks/databricks-gpt-5-6-sol",
        "messages": [{"role": "user", "content": "Compare these designs"}],
        "reasoning_effort": selector,
        "litellm_call_id": "numeric-chat-call",
    }

    routed = await reasoner.async_pre_call_hook(data=data, call_type="acompletion")

    assert routed["reasoning_effort"] == "medium"
    assert reasoner.samples == []
    assert reasoning_log_state({"litellm_call_id": "numeric-chat-call"}) is None


async def test_responses_numeric_selector_preserves_reasoning_fields(cache: ReasoningCache) -> None:
    reasoner = StubAutoReasoning(cache, [])
    data = {
        "model": "databricks/databricks-gpt-5-6-sol",
        "input": "Solve this",
        "reasoning": {"effort": 1, "summary": "concise"},
    }

    routed = await reasoner.async_pre_call_hook(data=data, call_type="aresponses")

    assert routed["reasoning"] == {"effort": "max", "summary": "concise"}


async def test_chat_gpt_5_6_caps_max_at_xhigh(cache: ReasoningCache) -> None:
    reasoner = StubAutoReasoning(cache, [])
    data = {
        "model": "databricks/databricks-gpt-5-6-sol",
        "messages": [{"role": "user", "content": "Solve this"}],
        "reasoning_effort": 1,
    }

    routed = await reasoner.async_pre_call_hook(data=data, call_type="acompletion")

    assert routed["reasoning_effort"] == "xhigh"


async def test_responses_shape_is_not_interpreted_on_chat_completions(
    cache: ReasoningCache,
) -> None:
    reasoner = StubAutoReasoning(cache, [])
    data = {
        "model": "databricks/databricks-gpt-5-6-sol",
        "messages": [{"role": "user", "content": "Solve this"}],
        "reasoning": {"effort": "auto"},
    }

    routed = await reasoner.async_pre_call_hook(data=data, call_type="acompletion")

    assert routed is data
    assert reasoner.samples == []


async def test_classifier_failure_uses_half_score_mapping(cache: ReasoningCache) -> None:
    reasoner = StubAutoReasoning(cache, [None])
    data = {
        "model": "databricks/databricks-gemini-3-5-flash",
        "messages": [{"role": "user", "content": "Compare these designs"}],
        "reasoning_effort": "auto",
    }

    routed = await reasoner.async_pre_call_hook(data=data, call_type="acompletion")

    assert routed["reasoning_effort"] == "medium"


async def test_claude_backend_uses_litellm_reasoning_mapping(cache: ReasoningCache) -> None:
    reasoner = StubAutoReasoning(cache, [0.1])
    data = {
        "model": "databricks/databricks-claude-sonnet-4-5",
        "messages": [{"role": "user", "content": "Translate this sentence"}],
        "reasoning_effort": "auto",
    }

    routed = await reasoner.async_pre_call_hook(data=data, call_type="acompletion")

    assert routed["reasoning_effort"] == "low"


def test_litellm_maps_claude_effort_to_thinking_budget() -> None:
    mapped = DatabricksConfig().map_openai_params(
        {"reasoning_effort": "low"},
        {},
        "databricks-claude-sonnet-4-5",
        True,
    )

    assert mapped["thinking"] == {"type": "enabled", "budget_tokens": 1024}


def test_patch_prevents_thinking_keyerror_for_non_claude_models() -> None:
    """reasoning_effort on a non-Claude model must not raise KeyError: 'thinking'.

    LiteLLM only converts reasoning_effort -> thinking for Claude, but reports
    thinking "enabled" for any reasoning_effort, so the follow-up token-budget
    lookup crashes for gpt-oss / gpt-5.x when no max_tokens is sent (the Open
    WebUI request shape). apply_litellm_patches() makes the missing-thinking
    case a no-op.
    """
    from dbx_tools.litellm import apply_litellm_patches

    apply_litellm_patches()  # idempotent

    mapped = DatabricksConfig().map_openai_params(
        {"reasoning_effort": "high"},
        {},
        "databricks-gpt-oss-120b",
        True,
    )

    # reasoning_effort is forwarded, no thinking block is invented, no crash.
    assert "thinking" not in mapped
    assert mapped.get("reasoning_effort") == "high"


def test_patch_unwraps_codex_namespace_tools() -> None:
    """A Codex `namespace` tool group must survive the Responses->Chat transform.

    LiteLLM's converter drops tool types it can't map to Chat Completions,
    including `namespace` — which is how Codex delivers its whole shell/apply-patch
    toolset. Dropping it leaves Codex with "no filesystem or terminal tools". The
    patch flattens the namespace into its inner function tools so they convert
    normally instead of being dropped.
    """
    from dbx_tools.litellm import apply_litellm_patches
    from litellm.responses.litellm_completion_transformation.transformation import (
        LiteLLMCompletionResponsesConfig,
    )

    apply_litellm_patches()  # idempotent

    tools = [
        {
            "type": "namespace",
            "name": "shell",
            "tools": [
                {
                    "type": "function",
                    "name": "exec",
                    "parameters": {"type": "object", "properties": {"cmd": {"type": "string"}}},
                }
            ],
        }
    ]

    converted, _ = (
        LiteLLMCompletionResponsesConfig.transform_responses_api_tools_to_chat_completion_tools(
            tools
        )
    )

    # The inner function survived instead of the whole namespace being dropped.
    names = [t.get("function", {}).get("name") for t in converted if t.get("type") == "function"]
    assert names == ["exec"]


async def test_no_auto_tag_is_no_op(cache: ReasoningCache) -> None:
    reasoner = StubAutoReasoning(cache, [0.8])
    data = {
        "model": "databricks/databricks-gpt-5-2",
        "messages": [{"role": "user", "content": "Solve this"}],
    }

    routed = await reasoner.async_pre_call_hook(data=data, call_type="acompletion")

    assert routed is data
    assert reasoner.samples == []


async def test_system_messages_are_not_sampled(cache: ReasoningCache) -> None:
    reasoner = StubAutoReasoning(cache, [0.1])
    data = {
        "model": "databricks/databricks-gpt-5-2",
        "messages": [
            {"role": "system", "content": "Sensitive deployment policy"},
            {"role": "user", "content": "Say hello"},
        ],
        "reasoning_effort": "auto",
    }

    await reasoner.async_pre_call_hook(data=data, call_type="acompletion")

    assert reasoner.samples == ["USER: Say hello"]


async def test_explicit_named_effort_maps_without_auto_metrics(cache: ReasoningCache) -> None:
    reasoner = StubAutoReasoning(cache, [0.8])
    data = {
        "model": "databricks/databricks-claude-sonnet-4-5",
        "messages": [{"role": "user", "content": "Solve this"}],
        "reasoning_effort": "extra-high",
        "litellm_call_id": "named-effort-call",
    }

    routed = await reasoner.async_pre_call_hook(data=data, call_type="acompletion")

    assert routed is not data
    assert routed["reasoning_effort"] == "xhigh"
    assert reasoner.samples == []
    assert reasoning_log_state({"litellm_call_id": "named-effort-call"}) is None


async def test_explicit_thinking_wins_over_auto(cache: ReasoningCache) -> None:
    reasoner = StubAutoReasoning(cache, [0.8])
    data = {
        "model": "databricks/databricks-claude-sonnet-4-5",
        "messages": [{"role": "user", "content": "Solve this"}],
        "reasoning_effort": "auto",
        "thinking": {"type": "enabled", "budget_tokens": 2048},
    }

    routed = await reasoner.async_pre_call_hook(data=data, call_type="acompletion")

    assert "reasoning_effort" not in routed
    assert routed["thinking"] == data["thinking"]
    assert reasoner.samples == []


async def test_unsupported_model_drops_auto_instead_of_forwarding_it(cache: ReasoningCache) -> None:
    reasoner = StubAutoReasoning(cache, [0.8])
    data = {
        "model": "databricks/databricks-meta-llama-3-1-8b-instruct",
        "messages": [{"role": "user", "content": "hello"}],
        "reasoning_effort": "auto",
    }

    routed = await reasoner.async_pre_call_hook(data=data, call_type="acompletion")

    assert "reasoning_effort" not in routed
    assert reasoner.samples == []


async def test_previous_response_id_restores_follow_up_context(cache: ReasoningCache) -> None:
    reasoner = StubAutoReasoning(cache, [0.5, 0.8])
    first = {
        "model": "databricks/databricks-gpt-5-2",
        "input": "Design a sharded queue",
        "reasoning": {"effort": "auto"},
        "litellm_call_id": "call-1",
    }
    await reasoner.async_pre_call_hook(data=first, call_type="aresponses")
    await reasoner.async_log_success_event(
        {"litellm_call_id": "call-1"},
        {"id": "resp-1"},
        None,
        None,
    )

    second = {
        "model": "databricks/databricks-gpt-5-2",
        "input": "Now make it survive a region outage",
        "previous_response_id": "resp-1",
        "reasoning": {"effort": "auto"},
    }
    await reasoner.async_pre_call_hook(data=second, call_type="aresponses")

    assert "Design a sharded queue" in reasoner.samples[-1]
    assert "Now make it survive a region outage" in reasoner.samples[-1]


async def test_non_opt_in_success_is_not_cached(cache: ReasoningCache) -> None:
    reasoner = StubAutoReasoning(cache, [])

    await reasoner.async_log_success_event(
        {"litellm_call_id": "ordinary-call", "input": "private prompt"},
        {"id": "ordinary-response"},
        None,
        None,
    )

    assert cache.get_turns("response:ordinary-response") == []


async def test_thread_metadata_restores_short_chat_follow_up(cache: ReasoningCache) -> None:
    reasoner = StubAutoReasoning(cache, [0.5, 0.8])
    first = {
        "model": "databricks/databricks-gpt-5-2",
        "messages": [{"role": "user", "content": "Plan a Postgres failover"}],
        "metadata": {"thread_id": "thread-1"},
        "reasoning_effort": "auto",
    }
    await reasoner.async_pre_call_hook(data=first, call_type="acompletion")

    second = {
        "model": "databricks/databricks-gpt-5-2",
        "messages": [{"role": "user", "content": "What about split brain?"}],
        "metadata": {"thread_id": "thread-1"},
        "reasoning_effort": "auto",
    }
    await reasoner.async_pre_call_hook(data=second, call_type="acompletion")

    assert "Plan a Postgres failover" in reasoner.samples[-1]
    assert "What about split brain?" in reasoner.samples[-1]


def test_cache_entries_have_a_ttl(tmp_path: Path) -> None:
    cache = ReasoningCache(tmp_path, ttl_seconds=30)
    cache.set_turns("thread:test", [{"role": "user", "content": "hello"}])

    value, expires_at = cache._cache.get("turns:thread:test", expire_time=True)

    assert value == [{"role": "user", "content": "hello"}]
    assert expires_at is not None
    assert 0 < expires_at - time.time() <= 30


def test_cached_score_round_trips(cache: ReasoningCache) -> None:
    sample = "USER: hello"
    cache.set_score(sample, 0.42)

    assert cache.get_score(sample) == 0.42


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("0.73", 0.73),
        ("73", 0.73),
        ("73%", 0.73),
        ("1", 1.0),
        ("0", 0.01),
        ("101", None),
    ],
)
def test_score_parser_corrects_integer_percentages(raw: str, expected: float | None) -> None:
    assert parse_score(raw) == expected


def test_score_one_uses_ultra_tier_only_when_supported() -> None:
    gpt_5_6 = reasoning_efforts_by_family("databricks-gpt-5-6-sol")
    gpt_5_5_pro = reasoning_efforts_by_family("databricks-gpt-5-5-pro")
    gemini = reasoning_efforts_by_family("databricks-gemini-3-5-flash")

    assert effort_for_score(1.0, gpt_5_6) == ReasoningEffort.MAX
    assert effort_for_score(1.0, gpt_5_5_pro) == ReasoningEffort.XHIGH
    assert effort_for_score(1.0, gemini) == ReasoningEffort.HIGH


def test_provider_specific_score_extremes() -> None:
    claude = reasoning_efforts_by_family("databricks-claude-sonnet-5")
    gemini = reasoning_efforts_by_family("databricks-gemini-3-5-flash")

    assert effort_for_score(0.01, claude) == ReasoningEffort.MINIMAL
    assert effort_for_score(0.9, claude) == ReasoningEffort.XHIGH
    assert effort_for_score(1.0, claude) == ReasoningEffort.MAX
    assert effort_for_score(0.01, gemini) == ReasoningEffort.MINIMAL
    assert effort_for_score(0.5, gemini) == ReasoningEffort.MEDIUM


@pytest.mark.parametrize(
    ("score", "expected"),
    [
        (0.33, ReasoningEffort.LOW),
        (0.34, ReasoningEffort.MEDIUM),
        (0.66, ReasoningEffort.MEDIUM),
        (0.67, ReasoningEffort.HIGH),
    ],
)
def test_score_bands_map_to_standard_efforts(score: float, expected: ReasoningEffort) -> None:
    efforts = reasoning_efforts_by_family("databricks-gpt-5-5")

    assert effort_for_score(score, efforts) == expected
