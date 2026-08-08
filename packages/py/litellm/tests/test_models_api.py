from __future__ import annotations

from dbx_tools.litellm.models_api import augment_models_payload
from dbx_tools.model import ServingEndpointSummary


def test_adds_codex_models_alongside_openai_data() -> None:
    payload = {
        "object": "list",
        "data": [
            {"id": "*", "object": "model"},
            {"id": "dbx/*", "object": "model"},
            {
                "id": "databricks/databricks-gpt-5-6-sol",
                "object": "model",
                "max_input_tokens": 272_000,
            },
            {
                "id": "databricks-claude-opus-5",
                "object": "model",
                "max_input_tokens": 200_000,
            },
            {"id": "databricks/databricks-claude-opus-5", "object": "model"},
        ],
    }

    augmented = augment_models_payload(payload)

    assert [model["id"] for model in augmented["data"]] == [
        "dbx/databricks-gpt-5-6-sol",
        "dbx/databricks-claude-opus-5",
        "dbx/databricks-gpt",
        "dbx/databricks-claude",
    ]
    assert [model["slug"] for model in augmented["models"]] == [
        "dbx/databricks-gpt-5-6-sol",
        "dbx/databricks-claude-opus-5",
        "dbx/databricks-gpt",
        "dbx/databricks-claude",
    ]
    gpt, claude, gpt_family, claude_family = augmented["models"]
    assert gpt["context_window"] == 272_000
    assert gpt["default_reasoning_level"] == "medium"
    assert [level["effort"] for level in gpt["supported_reasoning_levels"]] == [
        "none",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
    ]
    assert gpt["supports_reasoning_summary_parameter"] is True
    assert claude["supports_reasoning_summary_parameter"] is False
    gpt_data = augmented["data"][0]
    assert gpt_data["name"] == "GPT 5 6 Sol"
    assert gpt_data["context_window"] == 272_000
    assert "supports_reasoning" not in gpt_data
    assert "reasoning_efforts" not in gpt_data
    assert "supported_reasoning_levels" not in gpt_data
    assert "default_reasoning_effort" not in gpt_data
    assert gpt_family["context_window"] == 272_000
    assert claude_family["supports_reasoning_summary_parameter"] is False


def test_family_aliases_are_unique_and_only_cover_recognized_models() -> None:
    payload = {
        "object": "list",
        "data": [
            {"id": "databricks-gpt", "object": "model"},
            {"id": "databricks/databricks-gpt-5-6-sol", "object": "model"},
            {"id": "databricks-bge-large-en", "object": "model"},
            {"id": "custom-gpt-endpoint", "object": "model"},
            {"id": "custom-endpoint", "object": "model"},
        ],
    }

    augmented = augment_models_payload(payload)

    assert [model["id"] for model in augmented["data"]].count("dbx/databricks-gpt") == 1
    assert all(
        model["id"] not in {"dbx/databricks-bge", "dbx/databricks-custom"}
        for model in augmented["data"]
    )


def test_appends_each_recognized_basic_family_after_exact_models() -> None:
    exact_ids = [
        "databricks-gpt-oss-120b",
        "databricks-gemini-3-pro",
        "databricks-meta-llama-4-maverick",
        "databricks-qwen3-next",
        "databricks-glm-5",
        "databricks-gemma-3",
    ]
    payload = {
        "object": "list",
        "data": [{"id": model_id, "object": "model"} for model_id in exact_ids],
    }

    augmented = augment_models_payload(payload)

    assert [model["id"] for model in augmented["data"][: len(exact_ids)]] == [
        f"dbx/{model_id}" for model_id in exact_ids
    ]
    assert [model["id"] for model in augmented["data"][len(exact_ids) :]] == [
        "dbx/databricks-gpt-oss",
        "dbx/databricks-gemini",
        "dbx/databricks-llama",
        "dbx/databricks-qwen",
        "dbx/databricks-glm",
        "dbx/databricks-gemma",
    ]


def test_merges_live_endpoints_missing_from_litellm_registry() -> None:
    payload = {
        "object": "list",
        "data": [
            {"id": "databricks/databricks-gpt-5", "object": "model"},
            {"id": "databricks/databricks-gpt-5-6-sol", "object": "model"},
        ],
    }
    endpoints = [
        ServingEndpointSummary(name="databricks-gpt-5-6-sol"),
        ServingEndpointSummary(name="databricks-gpt-5-6-terra"),
    ]

    augmented = augment_models_payload(payload, endpoints)

    assert [model["id"] for model in augmented["data"]] == [
        "dbx/databricks-gpt-5-6-sol",
        "dbx/databricks-gpt-5-6-terra",
        "dbx/databricks-gpt",
    ]
    assert [model["name"] for model in augmented["data"]] == [
        "GPT 5 6 Sol",
        "GPT 5 6 Terra",
        "GPT",
    ]
    assert [model["slug"] for model in augmented["models"]] == [
        "dbx/databricks-gpt-5-6-sol",
        "dbx/databricks-gpt-5-6-terra",
        "dbx/databricks-gpt",
    ]


def test_live_discovery_removes_stale_registry_models() -> None:
    payload = {
        "object": "list",
        "data": [
            {"id": "*", "object": "model"},
            {"id": "databricks/*", "object": "model"},
            {"id": "custom-route", "object": "model"},
            {"id": "databricks/databricks-gpt-5", "object": "model"},
        ],
    }

    augmented = augment_models_payload(payload, [])

    assert [model["id"] for model in augmented["data"]] == ["custom-route"]
    assert [model["slug"] for model in augmented["models"]] == ["custom-route"]


def test_explicit_native_route_opts_into_databricks_models() -> None:
    payload = {
        "object": "list",
        "data": [
            {"id": "databricks/*", "object": "model"},
            {"id": "databricks/databricks-gpt-5-6-sol", "object": "model"},
        ],
    }

    augmented = augment_models_payload(
        payload,
        [ServingEndpointSummary(name="databricks-gpt-5-6-sol")],
    )

    assert [model["id"] for model in augmented["data"]] == [
        "dbx/databricks-gpt-5-6-sol",
        "databricks/databricks-gpt-5-6-sol",
        "dbx/databricks-gpt",
    ]


def test_keeps_already_qualified_dbx_models_without_native_duplicates() -> None:
    payload = {
        "object": "list",
        "data": [
            {"id": "dbx/databricks-gpt-5-6-sol", "object": "model"},
            {"id": "databricks/databricks-gpt-5-6-sol", "object": "model"},
            {"id": "databricks-gpt-5-6-sol", "object": "model"},
        ],
    }

    augmented = augment_models_payload(payload)

    assert [model["id"] for model in augmented["data"]] == [
        "dbx/databricks-gpt-5-6-sol",
        "dbx/databricks-gpt",
    ]
    assert all(model["id"].startswith("dbx/") for model in augmented["data"])


def test_non_reasoning_model_is_explicitly_advertised() -> None:
    payload = {"object": "list", "data": [{"id": "databricks-bge-large-en", "object": "model"}]}

    augmented = augment_models_payload(payload)

    assert "supports_reasoning" not in augmented["data"][0]
    assert "reasoning_efforts" not in augmented["data"][0]


def test_existing_codex_envelope_is_not_replaced() -> None:
    payload = {"data": [], "models": [{"slug": "existing"}]}

    assert augment_models_payload(payload) is payload


def test_non_list_payload_is_unchanged() -> None:
    payload = {"data": "not-a-list"}

    assert augment_models_payload(payload) is payload
