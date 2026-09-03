from __future__ import annotations

import pytest
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


def test_routed_names_need_no_prefix_registry() -> None:
    assert model_search_query("dbx/databricks/responses/databricks-gpt-5-6-sol") == "gpt 5 6 sol"


def test_compact_qwen_keeps_the_existing_central_sorting_components() -> None:
    assert version_tuple("databricks-qwen35-122b-a10b") == [35, 122, 0]
