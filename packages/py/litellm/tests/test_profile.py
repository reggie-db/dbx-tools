from __future__ import annotations

import json
import subprocess
from collections.abc import Sequence
from types import SimpleNamespace

import dbx_tools.litellm.backend as backend_module
import dbx_tools.litellm.cli as cli_module
import pytest
from dbx_tools.litellm.backend import DATABRICKS_PROFILE_ENV, ModelCatalogue, require_profile
from dbx_tools.model import ServingEndpointSummary
from dbx_tools.model.aliases import build_model_alias_index


def test_explicit_profile_wins_without_spawning_cli(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        backend_module.subprocess,
        "run",
        lambda *args, **kwargs: pytest.fail(f"unexpected CLI spawn: {args}, {kwargs}"),
    )

    assert (
        require_profile(
            "  explicit  ",
            environ={DATABRICKS_PROFILE_ENV: "environment"},
        )
        == "explicit"
    )


def test_environment_profile_wins_without_spawning_cli(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        backend_module.subprocess,
        "run",
        lambda *args, **kwargs: pytest.fail(f"unexpected CLI spawn: {args}, {kwargs}"),
    )

    assert require_profile(environ={DATABRICKS_PROFILE_ENV: "  environment  "}) == "environment"


def test_databricks_host_uses_ambient_auth_without_spawning_cli(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        backend_module.subprocess,
        "run",
        lambda *args, **kwargs: pytest.fail(f"unexpected CLI spawn: {args}, {kwargs}"),
    )

    assert require_profile(environ={"DATABRICKS_HOST": "https://workspace.example"}) is None


def test_uses_databricks_cli_default_profile(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[Sequence[str], dict[str, object]]] = []

    def run(command: Sequence[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        calls.append((command, kwargs))
        return subprocess.CompletedProcess(
            command,
            0,
            stdout='{"profiles":[{"name":"DEFAULT","default":true},{"name":"other"}]}',
            stderr="",
        )

    monkeypatch.setattr(backend_module.subprocess, "run", run)

    assert require_profile(environ={}) == "DEFAULT"
    assert calls == [
        (
            ["databricks", "auth", "profiles", "-o", "json", "--skip-validate"],
            {"check": True, "capture_output": True, "text": True},
        )
    ]


def test_missing_cli_default_has_actionable_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        backend_module.subprocess,
        "run",
        lambda *args, **kwargs: subprocess.CompletedProcess(
            args[0],
            0,
            stdout='{"profiles":[{"name":"other"}]}',
            stderr="",
        ),
    )

    with pytest.raises(RuntimeError, match="no configured default profile"):
        require_profile(environ={})


def test_cli_uses_environment_profile(monkeypatch: pytest.MonkeyPatch) -> None:
    proxy_arguments: list[str] = []
    monkeypatch.setenv(DATABRICKS_PROFILE_ENV, "environment")
    monkeypatch.setattr(
        cli_module,
        "_run_proxy",
        lambda arguments: proxy_arguments.extend(arguments),
    )

    cli_module.main(["--port", "4000"])

    assert proxy_arguments[:2] == ["--port", "4000"]
    assert "--config" in proxy_arguments
    assert backend_module.os.environ[DATABRICKS_PROFILE_ENV] == "environment"


def test_cli_sets_databricks_cli_default_in_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    proxy_arguments: list[str] = []
    monkeypatch.delenv(DATABRICKS_PROFILE_ENV, raising=False)
    monkeypatch.setattr(cli_module, "require_profile", lambda _: "DEFAULT")
    monkeypatch.setattr(
        cli_module,
        "_run_proxy",
        lambda arguments: proxy_arguments.extend(arguments),
    )

    cli_module.main(["--port", "4000"])

    assert proxy_arguments[:2] == ["--port", "4000"]
    assert backend_module.os.environ[DATABRICKS_PROFILE_ENV] == "DEFAULT"


def test_cli_allows_profile_override(monkeypatch: pytest.MonkeyPatch) -> None:
    proxy_arguments: list[str] = []
    monkeypatch.setattr(
        cli_module,
        "_run_proxy",
        lambda arguments: proxy_arguments.extend(arguments),
    )

    cli_module.main(["--profile", "other", "--port", "4000"])

    assert proxy_arguments[:2] == ["--port", "4000"]
    assert backend_module.os.environ[DATABRICKS_PROFILE_ENV] == "other"


@pytest.fixture
def models_cli(monkeypatch: pytest.MonkeyPatch) -> ModelCatalogue:
    endpoints = (
        ServingEndpointSummary(name="databricks-qwen35-122b-a10b"),
        ServingEndpointSummary(name="databricks-gpt-5-6-sol"),
    )
    catalogue = ModelCatalogue(
        endpoints=endpoints,
        aliases=build_model_alias_index(endpoint.name for endpoint in endpoints),
    )
    monkeypatch.setattr(cli_module, "require_profile", lambda profile: profile)
    monkeypatch.setattr(
        cli_module,
        "DatabricksLiteLLMBackend",
        lambda **_: SimpleNamespace(catalogue=lambda: catalogue),
    )
    return catalogue


def test_models_cli_defaults_to_alias_json(
    models_cli: ModelCatalogue,
    capsys: pytest.CaptureFixture[str],
) -> None:
    cli_module.main(["models", "--profile", "test"])

    assert json.loads(capsys.readouterr().out) == [
        "gpt-5.6-sol",
        "qwen3.5-122b-a10b",
    ]


def test_models_cli_alias_names_output_is_sorted(
    models_cli: ModelCatalogue,
    capsys: pytest.CaptureFixture[str],
) -> None:
    cli_module.main(["models", "--profile", "test", "--output", "names"])

    assert capsys.readouterr().out.splitlines() == [
        "gpt-5.6-sol",
        "qwen3.5-122b-a10b",
    ]


def test_models_cli_endpoints_json(
    models_cli: ModelCatalogue,
    capsys: pytest.CaptureFixture[str],
) -> None:
    cli_module.main(["models", "--profile", "test", "--endpoints"])

    payload = json.loads(capsys.readouterr().out)
    assert [model["name"] for model in payload] == [
        "databricks-gpt-5-6-sol",
        "databricks-qwen35-122b-a10b",
    ]
    assert payload[0]["aliases"] == ["gpt-5.6-sol"]
    assert payload[1]["aliases"] == ["qwen3.5-122b-a10b"]


def test_models_cli_endpoint_names(
    models_cli: ModelCatalogue,
    capsys: pytest.CaptureFixture[str],
) -> None:
    cli_module.main(["models", "--profile", "test", "--endpoints", "--output", "names"])

    assert capsys.readouterr().out.splitlines() == [
        "databricks-gpt-5-6-sol",
        "databricks-qwen35-122b-a10b",
    ]
