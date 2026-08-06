from __future__ import annotations

from dbx_tools.litellm.models_api import augment_models_payload


def test_adds_codex_models_alongside_openai_data() -> None:
    payload = {
        "object": "list",
        "data": [
            {"id": "*", "object": "model"},
            {"id": "databricks/*", "object": "model"},
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

    assert augmented["data"][: len(payload["data"])] == payload["data"]
    assert [model["id"] for model in augmented["data"][-2:]] == [
        "databricks-gpt",
        "databricks-claude",
    ]
    assert any(model["id"] == "databricks/databricks-gpt-5-6-sol" for model in augmented["data"])
    assert [model["slug"] for model in augmented["models"]] == [
        "databricks-gpt-5-6-sol",
        "databricks-claude-opus-5",
        "databricks-gpt",
        "databricks-claude",
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

    assert [model["id"] for model in augmented["data"]].count("databricks-gpt") == 1
    assert all(
        model["id"] not in {"databricks-bge", "databricks-custom"} for model in augmented["data"]
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

    assert [model["id"] for model in augmented["data"][: len(exact_ids)]] == exact_ids
    assert [model["id"] for model in augmented["data"][len(exact_ids) :]] == [
        "databricks-gpt-oss",
        "databricks-gemini",
        "databricks-llama",
        "databricks-qwen",
        "databricks-glm",
        "databricks-gemma",
    ]


def test_existing_codex_envelope_is_not_replaced() -> None:
    payload = {"data": [], "models": [{"slug": "existing"}]}

    assert augment_models_payload(payload) is payload


def test_non_list_payload_is_unchanged() -> None:
    payload = {"data": "not-a-list"}

    assert augment_models_payload(payload) is payload
