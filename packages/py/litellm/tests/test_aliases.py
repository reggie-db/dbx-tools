from __future__ import annotations

import pytest
from dbx_tools.litellm.aliases import (
    build_model_alias_index,
    generate_model_aliases,
)


@pytest.mark.parametrize(
    ("endpoint", "alias"),
    [
        ("databricks-gpt-5-6-sol", "dbx/gpt-5.6-sol"),
        ("databricks-gpt-oss-120b", "dbx/gpt-oss-120b"),
        ("databricks-claude-sonnet-4-6", "dbx/claude-sonnet-4-6"),
        ("databricks-gemini-3-8-flash", "dbx/gemini-3.8-flash"),
        ("databricks-qwen35-122b-a10b", "dbx/qwen3.5-122b-a10b"),
        (
            "databricks-qwen3-next-80b-a3b-instruct",
            "dbx/qwen3-next-80b-a3b-instruct",
        ),
        (
            "databricks-qwen3-embedding-0-6b",
            "dbx/qwen3-embedding-0-6b",
        ),
        (
            "databricks-meta-llama-3-3-70b-instruct",
            "dbx/llama-3.3-70b-instruct",
        ),
        ("databricks-llama-4-maverick", "dbx/llama-4-maverick"),
        ("databricks-gemma-3-12b", "dbx/gemma-3-12b"),
        ("databricks-glm-5-3-flash", "dbx/glm-5.3-flash"),
        ("databricks-grok-4-6", "dbx/grok-4.6"),
        ("databricks-deepseek-v4-pro-0813", "dbx/deepseek-v4-pro-0813"),
        ("databricks-deepseek-v4-flash-0731", "dbx/deepseek-v4-flash-0731"),
        ("databricks-kimi-k3", "dbx/kimi-k3"),
        ("databricks-gte-large-en", "dbx/gte-large-en"),
        ("databricks-bge-large-en", "dbx/bge-large-en"),
        ("databricks-inkling", "dbx/inkling"),
    ],
)
def test_generates_litellm_aliases(endpoint: str, alias: str) -> None:
    assert generate_model_aliases(endpoint) == (alias,)


def test_alias_index_reverse_resolves_case_and_whitespace() -> None:
    endpoint = "databricks-qwen35-122b-a10b"
    aliases = build_model_alias_index([endpoint])

    assert aliases.aliases_for(endpoint) == ("dbx/qwen3.5-122b-a10b",)
    assert aliases.search_for(" DBX/QWEN3.5-122b-a10b ") == "qwen 3 5 122b a10b"


def test_alias_matching_an_exact_endpoint_is_suppressed() -> None:
    aliases = build_model_alias_index(["databricks-gpt-5-6-sol", "dbx/gpt-5.6-sol"])

    assert aliases.aliases_for("databricks-gpt-5-6-sol") == ()
    assert aliases.search_for("dbx/gpt-5.6-sol") is None


def test_alias_shared_by_multiple_endpoints_is_suppressed() -> None:
    aliases = build_model_alias_index(
        [
            "databricks-deepseek-v4-pro-0813",
            "custom-deepseek-v4-pro-0813",
        ]
    )

    assert aliases.search_for("dbx/deepseek-v4-pro-0813") is None
