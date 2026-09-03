from __future__ import annotations

import pytest
from dbx_tools.model.models import (
    ModelFamily,
    ModelService,
    ParsedModelName,
    model_search_query,
    model_service_names,
    parse_model_name,
    version_tuple,
)


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (
            "databricks-gpt-5-6-sol ",
            ParsedModelName(
                source="databricks-gpt-5-6-sol",
                family=ModelFamily.GPT,
                version=(5, 6),
                model=("sol",),
            ),
        ),
        (
            "databricks-claude-sonnet-4-6",
            ParsedModelName(
                source="databricks-claude-sonnet-4-6",
                family=ModelFamily.CLAUDE,
                version=(4, 6),
                model=("sonnet",),
            ),
        ),
        (
            "databricks-qwen35-122b-a10b",
            ParsedModelName(
                source="databricks-qwen35-122b-a10b",
                family=ModelFamily.QWEN,
                version=(3, 5),
                model=("122b", "a10b"),
            ),
        ),
        (
            "qwen3.5-122B-A10B",
            ParsedModelName(
                source="qwen3.5-122B-A10B",
                family=ModelFamily.QWEN,
                version=(3, 5),
                model=("122b", "a10b"),
            ),
        ),
        (
            "databricks-qwen3-next-80b-a3b-instruct",
            ParsedModelName(
                source="databricks-qwen3-next-80b-a3b-instruct",
                family=ModelFamily.QWEN,
                version=(3,),
                model=("next", "80b", "a3b", "instruct"),
            ),
        ),
        (
            "databricks-meta-llama-3-3-70b-instruct",
            ParsedModelName(
                source="databricks-meta-llama-3-3-70b-instruct",
                family=ModelFamily.LLAMA,
                version=(3, 3),
                model=("70b", "instruct"),
            ),
        ),
    ],
)
def test_parses_provider_family_version_and_model(
    value: str,
    expected: ParsedModelName,
) -> None:
    assert parse_model_name(value) == expected


def test_routed_names_need_no_prefix_registry() -> None:
    assert model_search_query("dbx/databricks/responses/databricks-gpt-5-6-sol") == "gpt 5 6 sol"


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("databricks-gpt-5-6-sol", {ModelService.OPENAI: "gpt-5.6-sol"}),
        ("databricks-gpt-oss-120b", {}),
        (
            "databricks-claude-sonnet-4-6",
            {ModelService.ANTHROPIC: "claude-sonnet-4-6"},
        ),
        ("databricks-gemini-3-8-flash", {ModelService.GOOGLE: "gemini-3.8-flash"}),
        ("databricks-gemma-3-12b", {ModelService.GOOGLE: "gemma-3-12b"}),
        ("databricks-qwen35-122b-a10b", {ModelService.ALIBABA: "qwen3.5-122b-a10b"}),
        (
            "databricks-meta-llama-3-3-70b-instruct",
            {ModelService.META: "llama-3.3-70b-instruct"},
        ),
        ("databricks-glm-5-3-flash", {ModelService.ZHIPU: "glm-5.3-flash"}),
        ("databricks-grok-4-6", {ModelService.XAI: "grok-4.6"}),
        (
            "databricks-deepseek-v4-pro-0813",
            {ModelService.DEEPSEEK: "deepseek-v4-pro-0813"},
        ),
        ("databricks-kimi-k3", {ModelService.MOONSHOT: "kimi-k3"}),
        ("databricks-gte-large-en", {}),
        ("custom-endpoint", {}),
    ],
)
def test_returns_only_known_first_party_service_names(
    value: str,
    expected: dict[ModelService, str],
) -> None:
    assert model_service_names(value) == expected


def test_compact_qwen_keeps_the_existing_central_sorting_components() -> None:
    assert version_tuple("databricks-qwen35-122b-a10b") == [35, 122, 0]
