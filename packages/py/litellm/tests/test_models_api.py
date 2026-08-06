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

    assert augmented["data"] == payload["data"]
    assert [model["slug"] for model in augmented["models"]] == [
        "databricks-gpt-5-6-sol",
        "databricks-claude-opus-5",
    ]
    gpt, claude = augmented["models"]
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


def test_existing_codex_envelope_is_not_replaced() -> None:
    payload = {"data": [], "models": [{"slug": "existing"}]}

    assert augment_models_payload(payload) is payload


def test_non_list_payload_is_unchanged() -> None:
    payload = {"data": "not-a-list"}

    assert augment_models_payload(payload) is payload
