from __future__ import annotations

from dbx_tools.litellm.aliases import build_model_alias_index
from dbx_tools.litellm.models_api import (
    _alias_target_path,
    _rewrite_request_path,
    augment_models_payload,
)
from dbx_tools.model import ServingEndpointSummary
from starlette.requests import Request


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


def test_alias_models_view_replaces_each_known_exact_id_once() -> None:
    payload = {
        "object": "list",
        "data": [
            {
                "id": "databricks/databricks-gpt-5-6-sol",
                "object": "model",
                "max_input_tokens": 272_000,
            },
        ],
    }
    endpoints = [
        ServingEndpointSummary(name="databricks-gpt-5-6-sol"),
        ServingEndpointSummary(name="databricks-qwen35-122b-a10b"),
        ServingEndpointSummary(name="custom-endpoint"),
    ]
    aliases = build_model_alias_index(endpoint.name for endpoint in endpoints)

    augmented = augment_models_payload(
        payload,
        endpoints,
        aliases,
        alias_view=True,
    )

    assert [model["id"] for model in augmented["data"]] == [
        "gpt-5.6-sol",
        "qwen3.5-122b-a10b",
        "dbx/custom-endpoint",
    ]
    assert [model["slug"] for model in augmented["models"]] == [
        "gpt-5.6-sol",
        "qwen3.5-122b-a10b",
        "dbx/custom-endpoint",
    ]
    assert all("alias" not in model for model in augmented["data"])
    assert augmented["data"][0]["context_window"] == 272_000


def test_ambiguous_aliases_fall_back_to_exact_ids() -> None:
    endpoints = [
        ServingEndpointSummary(name="databricks-gpt-5-6-sol"),
        ServingEndpointSummary(name="custom-gpt-5-6-sol"),
    ]
    aliases = build_model_alias_index(endpoint.name for endpoint in endpoints)

    augmented = augment_models_payload(
        {"object": "list", "data": []},
        endpoints,
        aliases,
        alias_view=True,
    )

    assert [model["id"] for model in augmented["data"]] == [
        "dbx/databricks-gpt-5-6-sol",
        "dbx/custom-gpt-5-6-sol",
    ]


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


def test_alias_prefix_maps_to_the_standard_openai_prefix() -> None:
    assert _alias_target_path("/alias/v1") == "/v1"
    assert _alias_target_path("/alias/v1/models") == "/v1/models"
    assert _alias_target_path("/alias/v1/chat/completions") == "/v1/chat/completions"
    assert _alias_target_path("/alias/v1/responses") == "/v1/responses"
    assert _alias_target_path("/v1/models") is None
    assert _alias_target_path("/alias/v10/models") is None


def test_alias_request_rewrite_updates_routing_paths() -> None:
    request = Request(
        {
            "type": "http",
            "method": "POST",
            "scheme": "http",
            "path": "/alias/v1/chat/completions",
            "raw_path": b"/alias/v1/chat/completions",
            "query_string": b"stream=true",
            "headers": [],
            "client": ("127.0.0.1", 1234),
            "server": ("127.0.0.1", 4001),
        }
    )

    _rewrite_request_path(request, "/v1/chat/completions")

    assert request.scope["path"] == "/v1/chat/completions"
    assert request.scope["raw_path"] == b"/v1/chat/completions"
    assert request.scope["query_string"] == b"stream=true"
