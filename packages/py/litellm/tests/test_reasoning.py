from __future__ import annotations

import time
from pathlib import Path

import pytest
from dbx_tools.litellm.reasoning import DbxAutoReasoning, ReasoningCache
from dbx_tools.litellm.reasoning import _effort_for_score as effort_for_score
from dbx_tools.litellm.reasoning import _parse_score as parse_score
from dbx_tools.model import ReasoningEffort, reasoning_efforts_by_family
from litellm.llms.databricks.chat.transformation import DatabricksConfig


class StubAutoReasoning(DbxAutoReasoning):
    def __init__(self, cache: ReasoningCache, scores: list[float]) -> None:
        super().__init__(cache)
        self.scores = scores
        self.samples: list[str] = []

    async def _classify_score(self, sample: str):
        self.samples.append(sample)
        return self.scores.pop(0)

    async def _reasoning_efforts(self, model: str) -> tuple[ReasoningEffort, ...]:
        return reasoning_efforts_by_family(model)


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


async def test_explicit_effort_is_no_op(cache: ReasoningCache) -> None:
    reasoner = StubAutoReasoning(cache, [0.8])
    data = {
        "model": "databricks/databricks-gpt-5-2",
        "messages": [{"role": "user", "content": "Solve this"}],
        "reasoning_effort": "low",
    }

    routed = await reasoner.async_pre_call_hook(data=data, call_type="acompletion")

    assert routed is data
    assert routed["reasoning_effort"] == "low"


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
    gpt_5_5 = reasoning_efforts_by_family("databricks-gpt-5-5")

    assert effort_for_score(1.0, gpt_5_6) == ReasoningEffort.XHIGH
    assert effort_for_score(1.0, gpt_5_5) == ReasoningEffort.HIGH


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
