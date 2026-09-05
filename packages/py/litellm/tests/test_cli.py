from __future__ import annotations

import json

import dbx_tools.litellm.cli as cli_module
import pytest
from dbx_tools.model import ModelClass, ServingEndpointSummary


def test_models_command_prints_text_table(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(
        cli_module,
        "_models_payload",
        lambda profile: {
            "object": "list",
            "data": [
                {
                    "id": "dbx/databricks-gpt-5-6-sol",
                    "name": "GPT 5.6 Sol",
                    "owned_by": "dbx",
                    "context_window": 272_000,
                }
            ],
            "models": [
                {
                    "slug": "dbx/databricks-gpt-5-6-sol",
                    "supported_reasoning_levels": [
                        {"effort": "low"},
                        {"effort": "medium"},
                    ],
                }
            ],
        },
    )
    monkeypatch.setattr(
        cli_module,
        "_run_proxy",
        lambda arguments: pytest.fail("models must not start the proxy"),
    )

    cli_module.main(["models"])

    output = capsys.readouterr().out
    assert "dbx/databricks-gpt-5-6-sol" in output
    assert "GPT 5.6 Sol" in output
    assert "272,000" not in output
    assert "low, medium" not in output
    assert output.strip().startswith("NAME")


def test_models_command_extended_table_puts_name_first(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(
        cli_module,
        "_models_payload",
        lambda profile: {
            "data": [
                {
                    "id": "dbx/databricks-gpt-5-6-sol",
                    "name": "GPT 5.6 Sol",
                    "owned_by": "dbx",
                    "context_window": 272_000,
                }
            ],
            "models": [
                {
                    "slug": "dbx/databricks-gpt-5-6-sol",
                    "supported_reasoning_levels": [{"effort": "medium"}],
                }
            ],
        },
    )

    cli_module.main(["models", "--all"])

    output = capsys.readouterr().out
    assert output.strip().startswith("NAME")
    assert "NAME         ID" in output
    assert "272,000" in output
    assert "medium" in output


def test_models_command_prints_json(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    payload = {
        "object": "list",
        "data": [{"id": "dbx/databricks-claude-opus-5", "object": "model"}],
        "models": [{"slug": "dbx/databricks-claude-opus-5"}],
    }
    captured_profile: list[str | None] = []

    def models_payload(profile: str | None) -> object:
        captured_profile.append(profile)
        return payload

    monkeypatch.setattr(cli_module, "_models_payload", models_payload)
    monkeypatch.setattr(
        cli_module,
        "_run_proxy",
        lambda arguments: pytest.fail("models must not start the proxy"),
    )

    cli_module.main(["--profile", "other", "models", "--output", "json"])

    assert captured_profile == ["other"]
    assert json.loads(capsys.readouterr().out) == payload


def test_models_command_empty_catalogue_is_readable(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(
        cli_module,
        "_models_payload",
        lambda profile: {"object": "list", "data": [], "models": []},
    )

    cli_module.main(["models"])

    assert capsys.readouterr().out.strip() == "No models found."


def test_lookup_command_prints_name_id_and_score(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(
        cli_module,
        "_lookup_models",
        lambda keyword, profile: [
            {
                "endpoint": {
                    "name": "databricks-gpt-5-6-sol",
                    "displayName": "GPT 5.6 Sol",
                },
                "score": 0.125,
            }
        ],
    )

    cli_module.main(["lookup", "gpt"])

    output = capsys.readouterr().out
    assert output.strip().startswith("NAME")
    assert "GPT 5.6 Sol" in output
    assert "databricks-gpt-5-6-sol" in output
    assert "0.125" in output


def test_lookup_uses_standard_model_ranking(monkeypatch: pytest.MonkeyPatch) -> None:
    endpoints = [
        ServingEndpointSummary(
            name="databricks-gpt-5-4",
            displayName="GPT 5.4",
            model_class=ModelClass.CHAT_BALANCED,
            task="llm/v1/chat",
        ),
        ServingEndpointSummary(
            name="databricks-gpt-5-6",
            displayName="GPT 5.6",
            model_class=ModelClass.CHAT_BALANCED,
            task="llm/v1/chat",
        ),
    ]
    monkeypatch.setattr(cli_module, "_discover_endpoints", lambda profile: endpoints)

    ranked = cli_module._lookup_models("gpt", None)
    ranked_names = [
        endpoint["name"] for match in ranked if isinstance((endpoint := match["endpoint"]), dict)
    ]

    assert ranked_names == [
        "databricks-gpt-5-6",
        "databricks-gpt-5-4",
    ]
    assert all(isinstance(match["score"], float) for match in ranked)


def test_lookup_command_prints_ranked_json(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    ranked = [{"endpoint": {"name": "databricks-gpt-5-6"}, "score": 0.1}]
    monkeypatch.setattr(cli_module, "_lookup_models", lambda keyword, profile: ranked)

    cli_module.main(["lookup", "gpt", "--output", "json"])

    assert json.loads(capsys.readouterr().out) == ranked
