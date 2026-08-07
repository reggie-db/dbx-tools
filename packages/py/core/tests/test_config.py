from __future__ import annotations

from pathlib import Path

import pytest
from dbx_tools.core import config


def test_environment_keys_normalize_human_names() -> None:
    assert config.environment_keys("lakebaseEndpoint") == [
        "lakebaseEndpoint",
        "LAKEBASEENDPOINT",
        "LAKEBASE_ENDPOINT",
    ]


def test_constant_data_precedes_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SAMPLE", "environment")

    assert (
        config.text(
            "SAMPLE",
            {
                "data": {"SAMPLE": "configured"},
                "scope": (),
            },
        )
        == "configured"
    )


def test_custom_sources_append_constant_data(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SAMPLE", "environment")
    options: config.ConfigOptions = {
        "data": {"SAMPLE": "configured"},
        "scope": (),
        "sources": ("app", "env"),
    }

    assert config.text("SAMPLE", options) == "environment"
    monkeypatch.delenv("SAMPLE")
    assert config.text("SAMPLE", options) == "configured"


def test_resolve_value_reads_bundle_and_app_resources() -> None:
    assert (
        config.resolve_value(
            "WAREHOUSE",
            {
                "appData": {
                    "env": [{"name": "WAREHOUSE", "valueFrom": "warehouse"}],
                    "resources": [{"name": "warehouse", "sql_warehouse": {"id": "abc123"}}],
                },
                "scope": (),
                "sources": "app",
            },
        )
        == "abc123"
    )
    assert (
        config.resolve_value(
            "DATABASE",
            {
                "bundleData": {
                    "resources": {
                        "apps": {
                            "demo": {
                                "config": {"env": [{"name": "DATABASE", "value_from": "postgres"}]},
                                "resources": [
                                    {"name": "postgres", "postgres": {"database": "appdb"}}
                                ],
                            }
                        }
                    }
                },
                "scope": (),
                "sources": "bundle",
            },
        )
        == "appdb"
    )


def test_databricks_app_detection_honors_validated_values_and_override() -> None:
    detected = {
        "DATABRICKS_APP_NAME": "demo",
        "DATABRICKS_HOST": "https://workspace.example.com",
        "DATABRICKS_APP_PORT": "8000",
    }

    assert config.is_databricks_app_env(detected) is True
    assert config.is_databricks_app_env({**detected, config.DATABRICKS_APP_ENV_KEY: "off"}) is False
    assert config.is_databricks_app_env({**detected, "DATABRICKS_APP_PORT": "70000"}) is False


def test_typed_coercion_uses_sensible_fallbacks() -> None:
    assert config.boolean(" yes ", "UNUSED") is True
    assert config.boolean("OFF", "UNUSED") is False
    assert config.boolean("sometimes", "UNUSED") is None
    assert config.positive_number("25%", "UNUSED", 2) == 0.25
    assert config.positive_number(0, "UNUSED", 2) == 2
    assert config.positive_int("10.9", "UNUSED", 2) == 10
    assert config.list("docs.example.com, *.databricks.com docs.example.com", "UNUSED") == [
        "docs.example.com",
        "*.databricks.com",
    ]


def test_dotenv_discovery_reads_project_root(tmp_path: Path) -> None:
    project = tmp_path / "project"
    nested = project / "src" / "nested"
    nested.mkdir(parents=True)
    (project / "package.json").write_text('{"name":"fixture"}\n')
    (project / ".env").write_text("SAMPLE=dotenv\n")

    assert (
        config.text(
            "SAMPLE",
            {
                "cwd": str(nested),
                "scope": (),
                "sources": "dotenv",
            },
        )
        == "dotenv"
    )
