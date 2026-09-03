from __future__ import annotations

import pytest
from dbx_tools.model.aliases import (
    build_model_alias_index,
    generate_model_aliases,
)
from dbx_tools.model.models import (
    ModelFamily,
    ParsedModelName,
    model_search_query,
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


@pytest.mark.parametrize(
    ("endpoint", "alias"),
    [
        ("databricks-gpt-5-6-sol", "gpt-5.6-sol"),
        ("databricks-gpt-oss-120b", "gpt-oss-120b"),
        ("databricks-claude-sonnet-4-6", "claude-sonnet-4-6"),
        ("databricks-gemini-3-8-flash", "gemini-3.8-flash"),
        ("databricks-qwen35-122b-a10b", "qwen3.5-122b-a10b"),
        (
            "databricks-qwen3-next-80b-a3b-instruct",
            "qwen3-next-80b-a3b-instruct",
        ),
        (
            "databricks-qwen3-embedding-0-6b",
            "qwen3-embedding-0-6b",
        ),
        (
            "databricks-meta-llama-3-3-70b-instruct",
            "llama-3.3-70b-instruct",
        ),
        (
            "databricks-llama-4-maverick",
            "llama-4-maverick",
        ),
        ("databricks-gemma-3-12b", "gemma-3-12b"),
        ("databricks-glm-5-3-flash", "glm-5.3-flash"),
        ("databricks-grok-4-6", "grok-4.6"),
        ("databricks-deepseek-v4-pro-0813", "deepseek-v4-pro-0813"),
        ("databricks-deepseek-v4-flash-0731", "deepseek-v4-flash-0731"),
        ("databricks-kimi-k3", "kimi-k3"),
        ("databricks-gte-large-en", "gte-large-en"),
        ("databricks-bge-large-en", "bge-large-en"),
        ("databricks-inkling", "inkling"),
    ],
)
def test_generates_provider_native_aliases(endpoint: str, alias: str) -> None:
    assert generate_model_aliases(endpoint) == (alias,)


def test_alias_index_reverse_resolves_case_and_whitespace() -> None:
    endpoint = "databricks-qwen35-122b-a10b"
    aliases = build_model_alias_index([endpoint])

    assert aliases.aliases_for(endpoint) == ("qwen3.5-122b-a10b",)
    assert aliases.search_for(" QWEN3.5-122b-a10b ") == "qwen 3 5 122b a10b"


def test_alias_matching_an_exact_endpoint_is_suppressed() -> None:
    aliases = build_model_alias_index(["databricks-gpt-5-6-sol", "gpt-5.6-sol"])

    assert aliases.aliases_for("databricks-gpt-5-6-sol") == ()
    assert aliases.search_for("gpt-5.6-sol") is None


def test_alias_shared_by_multiple_endpoints_is_suppressed() -> None:
    aliases = build_model_alias_index(
        [
            "databricks-deepseek-v4-pro-0813",
            "custom-deepseek-v4-pro-0813",
        ]
    )

    assert aliases.search_for("deepseek-v4-pro-0813") is None


def test_routed_names_need_no_prefix_registry() -> None:
    assert model_search_query("dbx/databricks/responses/databricks-gpt-5-6-sol") == "gpt 5 6 sol"


def test_compact_qwen_keeps_the_existing_central_sorting_components() -> None:
    assert version_tuple("databricks-qwen35-122b-a10b") == [35, 122, 0]
