from dbx_tools.model_proxy.models_api import (
    _codex_model,
    _deprecated,
    _inject_openapi,
    _is_codex_originator,
    _is_litellm_ui_path,
    _openai_model,
    list_models_payload,
)


def test_openai_model_uses_node_endpoint_metadata() -> None:
    payload = _openai_model(
        {
            "name": "databricks-gpt-5-4",
            "displayName": "GPT 5.4",
            "task": "llm/v1/chat",
            "supportsTools": True,
            "reasoningEfforts": ["low", "medium", "high"],
            "status": {"deprecated": False},
            "metadata": {
                "capabilities": {
                    "responses": True,
                    "imageInput": True,
                    "applyPatch": False,
                    "webSearch": True,
                },
                "rateLimits": {"inputTokensPerMinute": 1000},
            },
        }
    )

    assert payload["id"] == "databricks-gpt-5-4"
    assert payload["capabilities"] == {
        "tools": True,
        "reasoning": ["low", "medium", "high"],
        "responses": True,
        "imageInput": True,
        "applyPatch": False,
        "webSearch": True,
    }
    assert payload["rate_limits"] == {"inputTokensPerMinute": 1000}
    assert _deprecated(payload) is False


def test_deprecated_reads_status_contract() -> None:
    assert _deprecated({"status": {"deprecated": True}}) is True


def test_codex_model_uses_node_metadata() -> None:
    payload = _codex_model(
        {
            "name": "databricks-gpt-5-6-sol",
            "displayName": "GPT 5.6 Sol",
            "family": "gpt",
            "modelServiceName": "system.ai.databricks-gpt-5-6-sol",
            "reasoningEfforts": ["none", "medium", "max"],
            "status": {"deprecated": False},
            "metadata": {
                "capabilities": {
                    "imageInput": True,
                    "applyPatch": True,
                    "webSearch": True,
                }
            },
        },
        priority=3,
    )

    assert payload is not None
    assert payload["slug"] == "databricks/system.ai.gpt-5-6-sol"
    assert payload["priority"] == 3
    assert payload["default_reasoning_level"] == "medium"
    assert payload["supported_reasoning_levels"] == [
        {"effort": "none", "description": "Disable explicit reasoning"},
        {"effort": "medium", "description": "Use a medium reasoning budget"},
        {"effort": "max", "description": "Use the largest available reasoning budget"},
    ]
    assert payload["apply_patch_tool_type"] == "freeform"
    assert payload["input_modalities"] == ["text", "image"]
    assert payload["supports_search_tool"] is True


def test_codex_payload_preserves_openai_models_and_filters_unsupported() -> None:
    payload = list_models_payload(
        [
            {
                "name": "databricks-gpt-5-6-sol",
                "family": "gpt",
                "reasoningEfforts": ["medium", "high"],
            },
            {"name": "databricks-claude-sonnet-4-6", "family": "claude"},
            {
                "name": "databricks-bge-large-en",
                "family": "bge",
                "class": "embedding",
            },
            {"name": "retired", "status": {"deprecated": True}},
        ],
        include_codex=True,
    )

    assert [model["id"] for model in payload["data"]] == [
        "databricks-gpt-5-6-sol",
        "databricks-claude-sonnet-4-6",
        "databricks-bge-large-en",
    ]
    assert [model["slug"] for model in payload["models"]] == ["databricks/system.ai.gpt-5-6-sol"]
    assert payload["models"][0]["priority"] == 1


def test_codex_originator_is_case_insensitive() -> None:
    assert _is_codex_originator(" Codex CLI ") is True
    assert _is_codex_originator("other") is False


def test_litellm_ui_paths_are_disabled_without_hiding_swagger() -> None:
    assert _is_litellm_ui_path("/ui") is True
    assert _is_litellm_ui_path("/get/ui_settings") is True
    assert _is_litellm_ui_path("/.well-known/litellm-ui-config") is True
    assert _is_litellm_ui_path("/login") is True
    assert _is_litellm_ui_path("/openapi.json") is False


def test_openapi_injects_lookup_controls_into_inference_routes() -> None:
    schema = {
        "paths": {
            "/ui": {"get": {}},
            "/get/ui_settings": {"get": {}},
            "/lookup": {
                "get": {
                    "operationId": "lookupDatabricksModels",
                    "parameters": [
                        {
                            "name": "threshold",
                            "in": "query",
                            "description": "Maximum fuzzy distance.",
                            "schema": {"type": "number", "minimum": 0, "maximum": 1},
                        }
                    ],
                }
            },
            "/v1/chat/completions": {
                "post": {
                    "requestBody": {
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {"model": {"type": "string"}},
                                }
                            }
                        }
                    }
                }
            },
        }
    }

    injected = _inject_openapi(schema)

    assert "/ui" not in injected["paths"]
    assert "/get/ui_settings" not in injected["paths"]
    lookup = injected["components"]["schemas"]["DbxToolsModelLookupParameters"]
    assert lookup["properties"]["threshold"]["maximum"] == 1
    operation = injected["paths"]["/v1/chat/completions"]["post"]
    assert operation["x-dbx-tools-model-routing"]["lookupPath"] == "/lookup"
    model = operation["requestBody"]["content"]["application/json"]["schema"]["properties"]["model"]
    assert "fuzzy model intent" in model["description"]
    assert injected["x-dbx-tools"]["uiEnabled"] is False
