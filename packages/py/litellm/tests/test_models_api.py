from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

from dbx_tools.litellm.models_api import (
    _model_identity_response,
    _request_endpoint,
    _request_ip,
    install_models_compatibility_middleware,
    list_models_payload,
    model_summary,
)
from dbx_tools.model import ModelStatus, ReasoningEffort, ServingEndpointSummary
from fastapi import Request


def endpoints() -> list[ServingEndpointSummary]:
    """Return representative live catalogue entries."""
    return [
        ServingEndpointSummary(
            name="databricks-gpt-5-6-sol",
            displayName="GPT 5.6 Sol",
            reasoningEfforts=[ReasoningEffort.LOW, ReasoningEffort.MEDIUM],
        ),
        ServingEndpointSummary(
            name="custom-detector",
            displayName="Custom Detector",
        ),
        ServingEndpointSummary(
            name="databricks-glm-5-2",
            displayName="GLM 5.2",
        ),
        ServingEndpointSummary(
            name="retired-model",
            status=ModelStatus(deprecated=True),
        ),
    ]


def test_standard_models_are_live_endpoint_records() -> None:
    payload = list_models_payload(endpoints(), include_codex=False)

    assert payload == {
        "object": "list",
        "data": [
            {
                "id": "databricks-gpt-5-6-sol",
                "object": "model",
                "owned_by": "databricks",
                "name": "GPT 5.6 Sol",
                "status": {"deprecated": False},
            },
            {
                "id": "custom-detector",
                "object": "model",
                "owned_by": "databricks",
                "name": "Custom Detector",
                "status": {"deprecated": False},
            },
            {
                "id": "databricks-glm-5-2",
                "object": "model",
                "owned_by": "databricks",
                "name": "GLM 5.2",
                "status": {"deprecated": False},
            },
        ],
    }


def test_codex_models_use_model_services_and_discovered_efforts() -> None:
    payload = list_models_payload(endpoints())
    models = payload["models"]

    assert [model["slug"] for model in models] == [
        "databricks/system.ai.gpt-5-6-sol",
        "databricks/system.ai.glm-5-2",
    ]
    assert models[0]["default_reasoning_level"] == "medium"
    assert [level["effort"] for level in models[0]["supported_reasoning_levels"]] == [
        "low",
        "medium",
    ]
    assert models[0]["priority"] == 1
    assert models[1]["priority"] == 2
    assert models[0]["base_instructions"]
    assert "default_reasoning_level" not in models[1]
    assert models[1]["supported_reasoning_levels"] == []


def test_model_summary_counts_live_families() -> None:
    assert model_summary(list_models_payload(endpoints())) == "3 models (1 glm, 1 gpt, 1 other)"


def test_models_request_uses_originating_forwarded_ip() -> None:
    request = Request(
        {
            "type": "http",
            "headers": [(b"x-forwarded-for", b"203.0.113.9, 10.0.0.8")],
            "client": ("127.0.0.1", 1234),
        }
    )

    assert _request_ip(request) == "203.0.113.9"


def test_lookup_endpoint_is_package_specific() -> None:
    from litellm.proxy.proxy_server import app

    install_models_compatibility_middleware()

    operation = app.openapi()["paths"]["/lookup"]["get"]
    assert operation["operationId"] == "lookupModels"
    assert "/v1/models/lookup" not in app.openapi()["paths"]
    assert {parameter["name"] for parameter in operation["parameters"]} == {
        "includeDeprecated",
        "limit",
        "modelClass",
        "requiresTools",
        "search",
        "threshold",
    }


def test_request_endpoint_completes_known_databricks_bases() -> None:
    assert (
        _request_endpoint(
            "https://workspace.example.com/ai-gateway/codex/v1",
            "/v1/responses",
        )
        == "https://workspace.example.com/ai-gateway/codex/v1/responses"
    )
    assert (
        _request_endpoint(
            "https://workspace.example.com/ai-gateway/mlflow/v1",
            "/v1/chat/completions",
        )
        == "https://workspace.example.com/ai-gateway/mlflow/v1/chat/completions"
    )


async def test_response_includes_model_identity_and_endpoint() -> None:
    class Response:
        status_code = 200
        media_type = "application/json"

        def __init__(self) -> None:
            self.headers = {
                "content-type": "application/json",
                "x-litellm-model-api-base": "https://workspace.example.com/ai-gateway/codex/v1",
            }
            self.body_iterator = self._body()

        async def _body(self) -> AsyncIterator[bytes]:
            yield json.dumps({"model": "gemini", "choices": []}).encode()

    class Backend:
        def resolve(self, requested: str, *, requires_tools: bool = False) -> str:
            assert requested == "gemini"
            assert requires_tools is False
            return "databricks-gemini-3-8-flash"

    response_source: Any = Response()
    response = await _model_identity_response(
        response_source,
        {"model": "gemini"},
        Backend(),
        request_path="/v1/responses",
    )

    assert json.loads(bytes(response.body)) == {
        "model": "databricks-gemini-3-8-flash",
        "requestedModel": "gemini",
        "requestEndpoint": "https://workspace.example.com/ai-gateway/codex/v1/responses",
        "choices": [],
    }
