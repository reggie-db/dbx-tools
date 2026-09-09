from __future__ import annotations

import json
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
    _ArgvPopen,
    _link_tool,
)
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


def test_start_neo4j_does_not_poll_readiness(monkeypatch, tmp_path: Path) -> None:
    runtime = Runtime(RuntimePaths(tmp_path))
    command = Mock(side_effect=[Mock(returncode=1), Mock(returncode=0)])
    monkeypatch.setattr(runtime, "_neo4j_command", command)

    runtime._start_neo4j()

    assert [call.args[0] for call in command.call_args_list] == ["status", "start"]


def test_honcho_child_preserves_argv_without_a_shell() -> None:
    argument = "value with spaces; exit 99"
    process = _ArgvPopen(
        [sys.executable, "-c", "import sys; sys.stdout.write(sys.argv[1])", argument]
    )

    output, _ = process.communicate(timeout=5)

    assert process.returncode == 0
    assert output.decode() == argument


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
            "databricks-gpt-5-mini",
            "--model-proxy-command",
            "/opt/dbx-model-proxy --target openai",
            "--model-proxy-port",
            "4100",
            "--",
            "--port",
            "9000",
        ]
    )

    assert start.call_args.kwargs["foreground"] is False
    assert start.call_args.kwargs["extra_args"] == ["--port", "9000"]
    assert start.call_args.kwargs["settings"].manage_model_proxy is True
    assert start.call_args.kwargs["settings"].profile == "DEV"
    assert start.call_args.kwargs["settings"].model == "databricks-gpt-5-mini"
    assert start.call_args.kwargs["settings"].model_proxy_command == (
        "/opt/dbx-model-proxy --target openai"
    )
    assert start.call_args.kwargs["settings"].model_proxy_port == 4100


def test_model_settings_default_to_managed_databricks_models() -> None:
    settings = ModelSettings.resolve(environ=_PROFILE_ENV)

    assert settings.manage_model_proxy is True
    assert settings.openai_api_url == "http://127.0.0.1:4000/v1"
    assert settings.model == "databricks-gpt-5-nano"
    assert settings.embedder_model == "databricks-gte-large-en"
    assert settings.embedder_dimensions == 1024
    assert settings.profile == "DEFAULT"
    assert settings.health_url == "http://127.0.0.1:4000/healthz"


def test_model_settings_delegate_default_profile_resolution() -> None:
    settings = ModelSettings.resolve(environ={})

    assert settings.profile is None


def test_model_settings_use_ambient_databricks_app_auth() -> None:
    settings = ModelSettings.resolve(
        environ={
            "DATABRICKS_HOST": "https://workspace.example",
            "DATABRICKS_CLIENT_ID": "client",
            "DATABRICKS_CLIENT_SECRET": "secret",
        }
    )

    assert settings.manage_model_proxy is True
    assert settings.profile is None


def test_model_settings_allow_external_model_proxy() -> None:
    settings = ModelSettings.resolve(
        model_proxy_url="https://models.example/v1/",
        environ={"DATABRICKS_CONFIG_PROFILE": "DEV"},
    )

    assert settings.manage_model_proxy is False
    assert settings.openai_api_url == "https://models.example/v1"
    assert settings.openai_api_key == "not-required"
    assert settings.profile == "DEV"


def test_model_settings_resolve_model_proxy_environment() -> None:
    settings = ModelSettings.resolve(
        environ={
            "MANAGE_MODEL_PROXY": "false",
            "MODEL_PROXY_COMMAND": "/opt/dbx-model-proxy --target auto",
            "MODEL_PROXY_HOST": "127.0.0.2",
            "MODEL_PROXY_PORT": "4100",
            "MODEL_PROXY_URL": "https://models.example/v1",
        },
    )

    assert settings.manage_model_proxy is False
    assert settings.model_proxy_command == "/opt/dbx-model-proxy --target auto"
    assert settings.model_proxy_host == "127.0.0.2"
    assert settings.model_proxy_port == 4100
    assert settings.openai_api_url == "https://models.example/v1"
    assert "model_proxy_command" not in settings.public_settings()


def test_model_settings_preserve_external_openai_api_url() -> None:
    settings = ModelSettings.resolve(
        environ={
            "OPENAI_API_URL": "https://openai.example/v1/",
            "OPENAI_API_KEY": "secret",
        },
    )

    assert settings.manage_model_proxy is False
    assert settings.openai_api_url == "https://openai.example/v1"
    assert settings.openai_api_key == "secret"


def test_status_uses_model_proxy_health(monkeypatch, tmp_path: Path) -> None:
    runtime = Runtime(RuntimePaths(tmp_path))
    runtime._write_state(
        {
            "neo4j_password": "secret",
            "model_settings": ModelSettings.resolve(environ=_PROFILE_ENV).public_settings(),
        }
    )
    health_urls: list[str] = []
    monkeypatch.setattr(
        "dbx_tools.graphiti.runtime._url_ready",
        lambda url: health_urls.append(url) or True,
    )

    status = runtime.status()

    assert status["model_proxy"] == "running"
    assert health_urls == ["http://127.0.0.1:4000/healthz"]


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
        "databricks-gpt-5-nano",
        "--embedder-provider",
        "openai",
        "--embedder-model",
        "databricks-gte-large-en",
    ]


def test_server_uses_temporary_empty_config(monkeypatch) -> None:
    from dbx_tools.graphiti.server import _upstream_config

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


def test_managed_model_proxy_uses_configured_argv_and_profile(monkeypatch, tmp_path: Path) -> None:
    runtime = Runtime(RuntimePaths(tmp_path))
    runtime._write_state({"neo4j_password": "secret"})
    settings = ModelSettings.resolve(
        profile="DEV",
        model_proxy_command="/opt/dbx-model-proxy --target openai",
        environ={"DATABRICKS_CONFIG_PROFILE": "DEFAULT"},
    )
    manager = Mock()
    manager.returncode = 0
    monkeypatch.setattr("dbx_tools.graphiti.runtime.Manager", Mock(return_value=manager))
    monkeypatch.setattr("dbx_tools.graphiti.runtime._url_ready", lambda _: False)

    result = runtime.supervise(settings, [])

    assert result == 0
    model_proxy = manager.add_process.call_args_list[0]
    assert model_proxy.args[0] == "model-proxy"
    assert model_proxy.args[1] == [
        "/opt/dbx-model-proxy",
        "--target",
        "openai",
        "--host",
        "127.0.0.1",
        "--port",
        "4000",
    ]
    assert model_proxy.kwargs["env"]["DATABRICKS_CONFIG_PROFILE"] == "DEV"
    assert manager.add_process.call_args_list[1].args[0] == "graphiti"
    assert isinstance(manager.add_process.call_args_list[1].args[1], list)
    manager.loop.assert_called_once_with()


def test_model_proxy_command_prefers_installed_binary(monkeypatch, tmp_path: Path) -> None:
    runtime = Runtime(RuntimePaths(tmp_path))
    monkeypatch.setattr(
        "dbx_tools.graphiti.runtime.shutil.which",
        lambda name: "/usr/local/bin/dbx-model-proxy" if name == "dbx-model-proxy" else None,
    )

    command = runtime._model_proxy_command(ModelSettings.resolve(environ=_PROFILE_ENV))

    assert command[:1] == ["/usr/local/bin/dbx-model-proxy"]


def test_model_proxy_command_falls_back_to_dbx(monkeypatch, tmp_path: Path) -> None:
    runtime = Runtime(RuntimePaths(tmp_path))
    monkeypatch.setattr(
        "dbx_tools.graphiti.runtime.shutil.which",
        lambda name: "/usr/local/bin/dbx" if name == "dbx" else None,
    )

    command = runtime._model_proxy_command(ModelSettings.resolve(environ=_PROFILE_ENV))

    assert command[:2] == ["/usr/local/bin/dbx", "model-proxy"]


def test_managed_model_proxy_rejects_an_occupied_port(monkeypatch, tmp_path: Path) -> None:
    runtime = Runtime(RuntimePaths(tmp_path))
    runtime._write_state({"neo4j_password": "secret"})
    manager = Mock()
    monkeypatch.setattr("dbx_tools.graphiti.runtime.Manager", Mock(return_value=manager))
    monkeypatch.setattr("dbx_tools.graphiti.runtime._url_ready", lambda _: True)

    with pytest.raises(RuntimeError, match="already in use"):
        runtime.supervise(ModelSettings.resolve(environ=_PROFILE_ENV), [])

    manager.add_process.assert_not_called()
