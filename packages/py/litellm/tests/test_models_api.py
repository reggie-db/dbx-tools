from __future__ import annotations

from dbx_tools.litellm.models_api import (
    _request_ip,
    _route_contains_path,
    augment_models_payload,
    install_models_compatibility_middleware,
    list_models_payload,
    model_summary,
)
from dbx_tools.model import ModelService, ServingEndpointSummary, lookup_models
from fastapi import Request


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
        serviceNames={ModelService.OPENAI: "gpt-5.6-sol"},
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


def test_model_summary_counts_each_advertised_family() -> None:
    payload = {
        "data": [
            {"id": "dbx/databricks-gpt-5-6-sol"},
            {"id": "dbx/databricks-gpt-5-5"},
            {"id": "dbx/databricks-claude-opus-4-1"},
            {"id": "dbx/databricks-claude-sonnet-4-6"},
            {"id": "dbx/databricks-claude-haiku-4-5"},
            {"id": "custom-route"},
        ]
    }

    assert model_summary(payload) == "6 models (3 claude, 2 gpt, 1 other)"


def test_models_request_uses_originating_forwarded_ip() -> None:
    request = Request(
        {
            "type": "http",
            "headers": [(b"x-forwarded-for", b"203.0.113.9, 10.0.0.8")],
            "client": ("127.0.0.1", 1234),
        }
    )

    assert _request_ip(request) == "203.0.113.9"


def test_lookup_payload_returns_scores_and_complete_models() -> None:
    matches = lookup_models(
        [
            ServingEndpointSummary(
                name="databricks-gpt-5-6-sol",
                displayName="GPT 5.6 Sol",
                task="llm/v1/chat",
                state="READY",
                description="Primary coding model",
            )
        ],
        {"search": "gpt"},
    )

    assert matches == [
        {
            "score": matches[0]["score"],
            "modelClass": "chat-balanced",
            "endpoint": {
                "name": "databricks-gpt-5-6-sol",
                "displayName": "GPT 5.6 Sol",
                "task": "llm/v1/chat",
                "state": "READY",
                "description": "Primary coding model",
                "reasoningEfforts": [],
                "serviceNames": {},
            },
        }
    ]


def test_empty_lookup_returns_all_eligible_models() -> None:
    matches = lookup_models(
        [
            ServingEndpointSummary(name="databricks-gpt-5-6", task="llm/v1/chat"),
            ServingEndpointSummary(name="databricks-claude-sonnet-4-6", task="llm/v1/chat"),
        ]
    )

    endpoints = [match["endpoint"] for match in matches]
    assert all(isinstance(endpoint, dict) for endpoint in endpoints)
    assert {endpoint["name"] for endpoint in endpoints if isinstance(endpoint, dict)} == {
        "databricks-claude-sonnet-4-6",
        "databricks-gpt-5-6",
    }


def test_lookup_endpoint_is_in_litellm_openapi() -> None:
    from litellm.proxy.proxy_server import app

    install_models_compatibility_middleware()

    operation = app.openapi()["paths"]["/v1/models/lookup"]["get"]
    assert operation["operationId"] == "lookupModels"
    assert operation["responses"]["200"]["content"]["application/json"]["schema"]["items"]["$ref"]
    assert {parameter["name"] for parameter in operation["parameters"]} == {
        "limit",
        "modelClass",
        "requiresTools",
        "search",
        "threshold",
    }
    lookup_index = next(
        index
        for index, route in enumerate(app.router.routes)
        if getattr(route, "path", None) == "/v1/models/lookup"
    )
    model_index = next(
        index
        for index, route in enumerate(app.router.routes)
        if _route_contains_path(route, "/v1/models/{model_id}")
    )
    assert lookup_index < model_index
