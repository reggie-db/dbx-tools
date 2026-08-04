from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
from dbx_tools.core import config


@pytest.fixture(autouse=True)
def reset_config_cache() -> None:
    config.clear_cache()


def fixture(tmp_path: Path) -> Path:
    (tmp_path / "package.json").write_text('{"name":"fixture"}\n', encoding="utf-8")
    return tmp_path


def test_resolves_scope_and_prefix_names_before_bare_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DBX_TOOLS_TUNNEL_AUTH_SUBJECT", "scoped")
    monkeypatch.setenv("TUNNEL_AUTH_SUBJECT", "prefixed")
    monkeypatch.setenv("AUTH_SUBJECT", "bare")

    assert config.text("AUTH_SUBJECT", {"scope": "DBX_TOOLS", "prefix": "TUNNEL"}) == "scoped"
    monkeypatch.delenv("DBX_TOOLS_TUNNEL_AUTH_SUBJECT")
    assert config.text("AUTH_SUBJECT", {"scope": "DBX_TOOLS", "prefix": "TUNNEL"}) == "prefixed"
    monkeypatch.delenv("TUNNEL_AUTH_SUBJECT")
    assert config.text("AUTH_SUBJECT", {"scope": "DBX_TOOLS", "prefix": "TUNNEL"}) == "bare"


def test_prefers_environment_over_dotenv(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    directory = fixture(tmp_path)
    (directory / ".env").write_text("DBX_TOOLS_SAMPLE=from-dotenv\n", encoding="utf-8")
    monkeypatch.setenv("DBX_TOOLS_SAMPLE", "from-env")

    assert (
        config.text("SAMPLE", {"cwd": str(directory), "sources": ["env", "dotenv"]}) == "from-env"
    )


def test_falls_back_to_dotenv_with_unscoped_keys(tmp_path: Path) -> None:
    directory = fixture(tmp_path)
    (directory / ".env").write_text(
        "export QUOTED='  kept  '\nPLAIN=value # trailing\n",
        encoding="utf-8",
    )

    assert config.text("QUOTED", {"cwd": str(directory), "sources": "dotenv"}) == "kept"
    assert config.text("PLAIN", {"cwd": str(directory), "sources": "dotenv"}) == "value"
    assert config.text("MISSING", {"cwd": str(directory), "sources": "dotenv"}) is None


def test_dotenv_matches_node_key_and_unmatched_quote_behavior(tmp_path: Path) -> None:
    directory = fixture(tmp_path)
    (directory / ".env").write_text(
        'A.B=dotted\nA-B=hyphenated\n1KEY=numeric\nOPEN="unterminated\nNEXT=value\n',
        encoding="utf-8",
    )

    options: config.ConfigOptions = {"cwd": str(directory), "sources": "dotenv", "scope": ()}
    assert config.text("A.B", options) == "dotted"
    assert config.text("A-B", options) == "hyphenated"
    assert config.text("1KEY", options) == "numeric"
    assert config.text("OPEN", options) == '"unterminated'
    assert config.text("NEXT", options) == "value"


def test_searches_from_cwd_upward_through_project_root(tmp_path: Path) -> None:
    root = fixture(tmp_path)
    parent = root / "packages"
    cwd = parent / "app"
    cwd.mkdir(parents=True)
    (root / ".env").write_text("SAMPLE=from-root\n", encoding="utf-8")
    (parent / ".env").write_text("SAMPLE=from-parent\n", encoding="utf-8")

    assert config.text("SAMPLE", {"cwd": str(cwd), "sources": "dotenv"}) == "from-parent"


def test_does_not_traverse_upward_without_project_root(tmp_path: Path) -> None:
    cwd = tmp_path / "nested"
    cwd.mkdir()
    (tmp_path / ".env").write_text("SAMPLE=from-parent\n", encoding="utf-8")

    assert config.text("SAMPLE", {"cwd": str(cwd), "sources": "dotenv"}) is None


def test_prefers_exact_environment_file_then_alias_then_dotenv(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    directory = fixture(tmp_path)
    (directory / ".env").write_text("SAMPLE=from-default\n", encoding="utf-8")
    (directory / ".env.production").write_text("SAMPLE=from-production\n", encoding="utf-8")
    (directory / ".env.prod").write_text("SAMPLE=from-prod\n", encoding="utf-8")

    monkeypatch.setenv("NODE_ENV", "production")
    assert config.text("SAMPLE", {"cwd": str(directory), "sources": "dotenv"}) == "from-production"

    monkeypatch.setenv("NODE_ENV", "prod")
    assert config.text("SAMPLE", {"cwd": str(directory), "sources": "dotenv"}) == "from-prod"


def test_bundle_app_precedes_variables_and_uses_partial_json(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    directory = fixture(tmp_path)
    (directory / "databricks.yml").write_text("bundle: {}\n", encoding="utf-8")
    payload = {
        "resources": {
            "apps": {
                "demo": {
                    "config": {
                        "env": [
                            {"name": "SAMPLE", "value": "from-app"},
                            {"name": "IGNORED", "value_from": "warehouse"},
                            {"name": "INTERPOLATED", "value": "${var.value}"},
                        ]
                    }
                }
            }
        },
        "variables": {
            "sample": {"value": "from-variable"},
            "fallback_name": {"default": "from-default"},
        },
    }
    calls: list[list[str]] = []

    def run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        calls.append(command)
        return subprocess.CompletedProcess(command, 1, json.dumps(payload), "validation warning")

    monkeypatch.setattr(config, "_project_root", lambda cwd: directory)
    monkeypatch.setattr(config.subprocess, "run", run)

    assert config.text("SAMPLE", {"cwd": str(directory), "sources": "bundle"}) == "from-app"
    assert (
        config.text("FALLBACK_NAME", {"cwd": str(directory), "sources": "bundle"}) == "from-default"
    )
    assert config.text("IGNORED", {"cwd": str(directory), "sources": "bundle"}) is None
    assert config.text("INTERPOLATED", {"cwd": str(directory), "sources": "bundle"}) is None
    assert calls == [
        ["databricks", "bundle", "validate", "--output", "json"],
        ["databricks", "bundle", "validate", "--output", "json"],
        ["databricks", "bundle", "validate", "--output", "json"],
        ["databricks", "bundle", "validate", "--output", "json"],
    ]


def test_bundle_lookup_is_lazy_when_environment_resolves(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    directory = fixture(tmp_path)
    (directory / "databricks.yml").write_text("bundle: {}\n", encoding="utf-8")
    monkeypatch.setenv("DBX_TOOLS_SAMPLE", "from-env")
    monkeypatch.setattr(config, "_project_root", lambda cwd: directory)

    def unexpected_run(*args: object, **kwargs: object) -> subprocess.CompletedProcess[str]:
        raise AssertionError("bundle validation should not run")

    monkeypatch.setattr(config.subprocess, "run", unexpected_run)

    assert config.text("SAMPLE", {"cwd": str(directory)}) == "from-env"


def test_malformed_bundle_variable_rejects_the_variables_block(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    directory = fixture(tmp_path)
    (directory / "databricks.yml").write_text("bundle: {}\n", encoding="utf-8")
    payload = {
        "variables": {
            "sample": {"value": "valid"},
            "malformed": {"value": 123},
        }
    }

    def run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(command, 0, json.dumps(payload), "")

    monkeypatch.setattr(config, "_project_root", lambda cwd: directory)
    monkeypatch.setattr(config.subprocess, "run", run)

    assert config.text("SAMPLE", {"cwd": str(directory), "sources": "bundle"}) is None


def test_bundle_lookup_is_cached_in_current_working_directory(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    directory = fixture(tmp_path)
    (directory / "databricks.yml").write_text("bundle: {}\n", encoding="utf-8")
    monkeypatch.chdir(directory)
    monkeypatch.setattr(config, "_project_root", lambda cwd: directory)
    calls = 0

    def run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        nonlocal calls
        calls += 1
        return subprocess.CompletedProcess(
            command,
            0,
            json.dumps({"variables": {"sample": {"value": "cached"}}}),
            "",
        )

    monkeypatch.setattr(config.subprocess, "run", run)

    assert config.text("SAMPLE", {"sources": "bundle"}) == "cached"
    assert config.text("SAMPLE", {"sources": "bundle"}) == "cached"
    assert calls == 1


def test_recognizes_complete_databricks_app_environment() -> None:
    valid = {
        "DATABRICKS_APP_NAME": "demo",
        "DATABRICKS_HOST": "https://workspace.example.com",
        "DATABRICKS_APP_PORT": "8000",
    }

    assert config.is_databricks_app_env(valid) is True


def test_rejects_invalid_databricks_app_environment() -> None:
    valid = {
        "DATABRICKS_APP_NAME": "demo",
        "DATABRICKS_HOST": "https://workspace.example.com",
        "DATABRICKS_APP_PORT": "8000",
    }

    assert config.is_databricks_app_env({**valid, "DATABRICKS_HOST": "file:///tmp"}) is False
    assert config.is_databricks_app_env({**valid, "DATABRICKS_APP_PORT": "0"}) is False
    assert config.is_databricks_app_env({**valid, "DATABRICKS_APP_NAME": ""}) is False
