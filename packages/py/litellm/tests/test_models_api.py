from __future__ import annotations

from dbx_tools.litellm.models_api import (
    augment_models_payload,
    list_models_payload,
)
from dbx_tools.model import ServingEndpointSummary


def test_standard_models_view_uses_exact_ids_and_openai_data_envelope() -> None:
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
                "id": "databricks/databricks-claude-opus-5",
                "object": "model",
                "max_input_tokens": 200_000,
            },
        ],
    }

    augmented = augment_models_payload(payload)

    assert augmented["object"] == "list"
    assert [model["id"] for model in augmented["data"]] == [
        "dbx/databricks-gpt-5-6-sol",
        "dbx/databricks-claude-opus-5",
    ]
    assert [model["slug"] for model in augmented["models"]] == [
        "dbx/databricks-gpt-5-6-sol",
        "dbx/databricks-claude-opus-5",
    ]
    assert all("alias" not in model for model in augmented["data"])
    assert augmented["data"][0]["context_window"] == 272_000
    assert augmented["models"][0]["default_reasoning_level"] == "medium"


def test_standard_view_can_include_explicit_native_databricks_models() -> None:
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
    ]


def test_standard_view_does_not_expose_library_service_names() -> None:
    endpoint = ServingEndpointSummary(
        name="databricks-gpt-5-6-sol",
        serviceNames={"openai": "gpt-5.6-sol"},
    )

    augmented = augment_models_payload({"object": "list", "data": []}, [endpoint])

    assert "serviceNames" not in augmented["data"][0]
    assert "service_names" not in augmented["data"][0]


def test_live_discovery_removes_stale_registry_models() -> None:
    payload = {
        "object": "list",
        "data": [
            {"id": "*", "object": "model"},
            {"id": "custom-route", "object": "model"},
            {"id": "databricks/databricks-gpt-5", "object": "model"},
        ],
    }

    augmented = augment_models_payload(payload, [])

    assert [model["id"] for model in augmented["data"]] == ["custom-route"]
    assert [model["slug"] for model in augmented["models"]] == ["custom-route"]


def test_existing_codex_envelope_is_not_replaced() -> None:
    payload = {"data": [], "models": [{"slug": "existing"}]}

    assert augment_models_payload(payload) is payload


def test_non_list_payload_is_unchanged() -> None:
    payload = {"data": "not-a-list"}

    assert augment_models_payload(payload) is payload


def test_cli_seed_matches_packaged_proxy_routes() -> None:
    endpoint = ServingEndpointSummary(name="databricks-gpt-5-6-sol")

    augmented = list_models_payload([endpoint])

    assert [model["id"] for model in augmented["data"]] == ["dbx/databricks-gpt-5-6-sol"]
    assert [model["slug"] for model in augmented["models"]] == ["dbx/databricks-gpt-5-6-sol"]
