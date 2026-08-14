from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import Mock

from dbx_tools.graphiti.cli import main
from dbx_tools.graphiti.runtime import GRAPHITI_VERSION, Runtime, RuntimePaths
from dbx_tools.graphiti.settings import ModelSettings

_PROFILE_ENV = {"DATABRICKS_CONFIG_PROFILE": "DEFAULT"}


def test_runtime_paths_are_versioned(tmp_path: Path) -> None:
    paths = RuntimePaths(tmp_path)

    assert paths.graphiti == tmp_path / "graphiti" / GRAPHITI_VERSION
    assert paths.neo4j_data == tmp_path / "data" / "neo4j"


def test_environment_preserves_explicit_neo4j_values(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("NEO4J_URI", "bolt://example:7687")
    runtime = Runtime(RuntimePaths(tmp_path))

    environment = runtime.environment(
        "generated",
        ModelSettings.resolve(environ=_PROFILE_ENV),
    )

    assert environment["NEO4J_URI"] == "bolt://example:7687"
    assert environment["NEO4J_PASSWORD"] == "generated"


def test_connection_settings_do_not_expose_unrelated_environment(
    monkeypatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "do-not-print")
    runtime = Runtime(RuntimePaths(tmp_path))

    settings = runtime.connection_settings(
        "generated",
        ModelSettings.resolve(
            environ={**_PROFILE_ENV, "OPENAI_API_KEY": "do-not-print"},
        ),
    )

    assert "OPENAI_API_KEY" not in settings
    assert settings["NEO4J_PASSWORD"] == "generated"


def test_state_is_private(tmp_path: Path) -> None:
    runtime = Runtime(RuntimePaths(tmp_path))

    runtime._write_state({"neo4j_password": "secret"})

    assert json.loads(runtime.paths.state.read_text()) == {"neo4j_password": "secret"}
    assert runtime.paths.state.stat().st_mode & 0o777 == 0o600


def test_setup_is_cached(monkeypatch, tmp_path: Path) -> None:
    runtime = Runtime(RuntimePaths(tmp_path))
    runtime.paths.neo4j.joinpath("bin").mkdir(parents=True)
    runtime.paths.neo4j.joinpath("bin", "neo4j").touch()
    runtime.paths.graphiti.joinpath("mcp_server").mkdir(parents=True)
    runtime.paths.graphiti.joinpath("mcp_server", "main.py").touch()
    runtime.paths.root.mkdir(parents=True, exist_ok=True)
    runtime.paths.state.write_text('{"neo4j_password":"secret"}')
    run = Mock(return_value=Mock(returncode=0))
    monkeypatch.setattr("dbx_tools.graphiti.runtime.shutil.which", lambda _: "/bin/mise")
    monkeypatch.setattr("dbx_tools.graphiti.runtime.subprocess.run", run)

    runtime.setup()

    assert run.call_count == 2
    assert all(call.args[0][:2] == ["mise", "where"] for call in run.call_args_list)


def test_cli_strips_argument_separator(monkeypatch) -> None:
    start = Mock(return_value=123)
    monkeypatch.setenv("DATABRICKS_CONFIG_PROFILE", "DEFAULT")
    monkeypatch.setattr("dbx_tools.graphiti.cli.Runtime.start", start)
    monkeypatch.setattr("dbx_tools.graphiti.cli.Runtime.status", Mock(return_value={}))

    main(
        [
            "up",
            "--profile",
            "DEV",
            "--model",
            "dbx/databricks-gpt-5-mini",
            "--",
            "--port",
            "9000",
        ]
    )

    assert start.call_args.kwargs["foreground"] is False
    assert start.call_args.kwargs["extra_args"] == ["--port", "9000"]
    assert start.call_args.kwargs["settings"].manage_litellm is True
    assert start.call_args.kwargs["settings"].profile == "DEV"
    assert start.call_args.kwargs["settings"].model == "dbx/databricks-gpt-5-mini"


def test_model_settings_default_to_managed_databricks_models() -> None:
    settings = ModelSettings.resolve(environ=_PROFILE_ENV)

    assert settings.manage_litellm is True
    assert settings.openai_api_url == "http://127.0.0.1:4000/v1"
    assert settings.model == "dbx/databricks-gpt-5-nano"
    assert settings.embedder_model == "dbx/databricks-gte-large-en"
    assert settings.embedder_dimensions == 1024
    assert settings.profile == "DEFAULT"


def test_model_settings_use_databricks_cli_default(monkeypatch) -> None:
    resolve_profile = Mock(return_value="DEFAULT")
    monkeypatch.setattr(
        "dbx_tools.graphiti.settings.require_profile",
        resolve_profile,
    )

    settings = ModelSettings.resolve(environ={})

    assert settings.profile == "DEFAULT"
    resolve_profile.assert_called_once_with(None, environ={})


def test_model_settings_allow_external_litellm() -> None:
    settings = ModelSettings.resolve(
        litellm_url="https://models.example/v1/",
        environ={"DATABRICKS_CONFIG_PROFILE": "DEV"},
    )

    assert settings.manage_litellm is False
    assert settings.openai_api_url == "https://models.example/v1"
    assert settings.openai_api_key == "not-required"
    assert settings.profile == "DEV"


def test_graphiti_command_does_not_require_config_yaml(tmp_path: Path) -> None:
    runtime = Runtime(RuntimePaths(tmp_path))
    settings = ModelSettings.resolve(environ=_PROFILE_ENV)

    command = runtime.graphiti_command(settings, [])

    assert "--config" not in command
    assert command[-8:] == [
        "--llm-provider",
        "openai",
        "--model",
        "dbx/databricks-gpt-5-nano",
        "--embedder-provider",
        "openai",
        "--embedder-model",
        "dbx/databricks-gte-large-en",
    ]


def test_managed_litellm_uses_selected_profile(monkeypatch, tmp_path: Path) -> None:
    runtime = Runtime(RuntimePaths(tmp_path))
    runtime._write_state({"neo4j_password": "secret"})
    state = runtime.read_state()
    settings = ModelSettings.resolve(
        profile="DEV",
        environ={"DATABRICKS_CONFIG_PROFILE": "DEFAULT"},
    )
    readiness = iter([False, True])
    popen = Mock(return_value=Mock(pid=321))
    monkeypatch.setattr("dbx_tools.graphiti.runtime._url_ready", lambda _: next(readiness))
    monkeypatch.setattr("dbx_tools.graphiti.runtime.subprocess.Popen", popen)

    owns_process = runtime._start_litellm(settings, state)

    assert owns_process is True
    assert popen.call_args.args[0] == [
        sys.executable,
        "-m",
        "dbx_tools.litellm",
        "--host",
        "127.0.0.1",
        "--port",
        "4000",
    ]
    assert popen.call_args.kwargs["env"]["DATABRICKS_CONFIG_PROFILE"] == "DEV"
    assert runtime.read_state()["litellm_pid"] == 321
