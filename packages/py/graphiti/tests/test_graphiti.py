from __future__ import annotations

import json
import shlex
import sys
from pathlib import Path
from unittest.mock import Mock

import pytest
from dbx_tools.graphiti.cli import main
from dbx_tools.graphiti.constants import UPSTREAM_MCP_PATH_ENV
from dbx_tools.graphiti.proxy import caddy_config
from dbx_tools.graphiti.runtime import (
    GRAPHITI_VERSION,
    JAVA_MISE_TOOL,
    UV_MISE_TOOL,
    Runtime,
    RuntimePaths,
    _link_tool,
)
from dbx_tools.graphiti.server import _upstream_config
from dbx_tools.graphiti.settings import ModelSettings

_PROFILE_ENV = {"DATABRICKS_CONFIG_PROFILE": "DEFAULT"}


def test_runtime_paths_are_versioned(tmp_path: Path) -> None:
    paths = RuntimePaths(tmp_path)

    assert paths.graphiti == tmp_path / "tools" / "graphiti" / GRAPHITI_VERSION
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
    assert environment["LLM__PROVIDERS__OPENAI__API_URL"] == "http://127.0.0.1:4000/v1"
    assert environment["EMBEDDER__PROVIDERS__OPENAI__API_KEY"] == "not-required"
    assert environment[UPSTREAM_MCP_PATH_ENV] == str(runtime.paths.graphiti / "mcp_server")
    assert str(Path(__file__).parents[1] / "src") in environment["PYTHONPATH"]


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


def test_startup_resolves_prerequisites_through_core_bin(monkeypatch, tmp_path: Path) -> None:
    runtime = Runtime(RuntimePaths(tmp_path))
    ensure_tool = Mock()
    resolve = Mock(return_value="/bin/uv")
    install_neo4j = Mock()
    install_graphiti = Mock()
    ensure_state = Mock()
    monkeypatch.setattr("dbx_tools.graphiti.runtime.bin.ensure_tool", ensure_tool)
    monkeypatch.setattr("dbx_tools.graphiti.runtime.bin.resolve", resolve)
    monkeypatch.setattr(runtime, "_install_neo4j", install_neo4j)
    monkeypatch.setattr(runtime, "_install_graphiti", install_graphiti)
    monkeypatch.setattr(runtime, "_ensure_state", ensure_state)

    runtime._ensure_runtime()

    ensure_tool.assert_called_once_with(JAVA_MISE_TOOL)
    resolve.assert_called_once_with("uv", mise_tool=UV_MISE_TOOL)
    install_neo4j.assert_called_once_with()
    install_graphiti.assert_called_once_with()
    ensure_state.assert_called_once_with()


def test_tool_link_targets_mise_install_path(tmp_path: Path) -> None:
    source = tmp_path / "mise" / "installs" / "tool" / "1.0"
    source.mkdir(parents=True)
    destination = tmp_path / "runtime" / "tool"

    _link_tool(source, destination)
    _link_tool(source, destination)

    assert destination.readlink() == source


def test_neo4j_auth_failure_resets_only_ephemeral_persistent_store(
    monkeypatch, tmp_path: Path
) -> None:
    runtime = Runtime(RuntimePaths(tmp_path))
    command = Mock(return_value=Mock(returncode=0))
    wait = Mock(side_effect=[(False, True), (True, False)])
    set_password = Mock()
    remove_data = Mock()
    monkeypatch.setenv("LAKEBASE_ENDPOINT", "projects/demo/branches/main/endpoints/primary")
    monkeypatch.setattr(runtime, "_neo4j_command", command)
    monkeypatch.setattr(runtime, "_wait_for_neo4j", wait)
    monkeypatch.setattr(runtime, "_set_initial_password", set_password)
    monkeypatch.setattr("dbx_tools.graphiti.runtime.shutil.rmtree", remove_data)

    runtime._start_neo4j("secret")

    set_password.assert_called_once_with("secret")
    remove_data.assert_called_once_with(runtime.paths.neo4j_data, ignore_errors=True)
    assert [call.args[0] for call in command.call_args_list] == ["status", "stop", "start"]


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


def test_model_settings_use_ambient_databricks_app_auth() -> None:
    settings = ModelSettings.resolve(
        environ={
            "DATABRICKS_HOST": "https://workspace.example",
            "DATABRICKS_CLIENT_ID": "client",
            "DATABRICKS_CLIENT_SECRET": "secret",
        }
    )

    assert settings.manage_litellm is True
    assert settings.profile is None


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
    assert command[command.index("-m") + 1] == "dbx_tools.graphiti.server"
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


def test_server_uses_temporary_empty_config(monkeypatch) -> None:
    monkeypatch.setattr("dbx_tools.graphiti.server.sys.argv", ["dbx-graphiti"])

    with _upstream_config():
        config_path = Path(sys.argv[sys.argv.index("--config") + 1])
        assert config_path.read_text() == "{}\n"

    assert sys.argv == ["dbx-graphiti"]
    assert not config_path.exists()


def test_graphiti_command_uses_databricks_app_listener(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("DATABRICKS_APP_PORT", "9001")
    runtime = Runtime(RuntimePaths(tmp_path))

    command = runtime.graphiti_command(ModelSettings.resolve(environ=_PROFILE_ENV), [])

    assert command[command.index("--host") + 1] == "0.0.0.0"
    assert command[command.index("--port") + 1] == "9001"


def test_caddy_config_routes_to_graphiti() -> None:
    config = caddy_config(
        proxy_port=8000,
        graphiti_port=8002,
    )

    assert "127.0.0.1:8000" in config
    assert "reverse_proxy 127.0.0.1:8002" in config


def test_managed_litellm_uses_selected_profile(monkeypatch, tmp_path: Path) -> None:
    runtime = Runtime(RuntimePaths(tmp_path))
    runtime._write_state({"neo4j_password": "secret"})
    settings = ModelSettings.resolve(
        profile="DEV",
        environ={"DATABRICKS_CONFIG_PROFILE": "DEFAULT"},
    )
    manager = Mock()
    manager.returncode = 0
    monkeypatch.setattr("dbx_tools.graphiti.runtime.Manager", Mock(return_value=manager))
    monkeypatch.setattr("dbx_tools.graphiti.runtime._url_ready", lambda _: False)

    result = runtime.supervise(settings, [])

    assert result == 0
    litellm = manager.add_process.call_args_list[0]
    assert litellm.args[0] == "litellm"
    assert shlex.split(litellm.args[1]) == [
        sys.executable,
        "-m",
        "dbx_tools.litellm",
        "--host",
        "127.0.0.1",
        "--port",
        "4000",
    ]
    assert litellm.kwargs["env"]["DATABRICKS_CONFIG_PROFILE"] == "DEV"
    assert manager.add_process.call_args_list[1].args[0] == "graphiti"
    manager.loop.assert_called_once_with()


def test_managed_litellm_rejects_an_occupied_port(monkeypatch, tmp_path: Path) -> None:
    runtime = Runtime(RuntimePaths(tmp_path))
    runtime._write_state({"neo4j_password": "secret"})
    manager = Mock()
    monkeypatch.setattr("dbx_tools.graphiti.runtime.Manager", Mock(return_value=manager))
    monkeypatch.setattr("dbx_tools.graphiti.runtime._url_ready", lambda _: True)

    with pytest.raises(RuntimeError, match="already in use"):
        runtime.supervise(ModelSettings.resolve(environ=_PROFILE_ENV), [])

    manager.add_process.assert_not_called()
