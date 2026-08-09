from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import Mock

from dbx_tools.graphiti.cli import main
from dbx_tools.graphiti.runtime import GRAPHITI_VERSION, Runtime, RuntimePaths


def test_runtime_paths_are_versioned(tmp_path: Path) -> None:
    paths = RuntimePaths(tmp_path)

    assert paths.graphiti == tmp_path / "graphiti" / GRAPHITI_VERSION
    assert paths.neo4j_data == tmp_path / "data" / "neo4j"


def test_environment_preserves_explicit_neo4j_values(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("NEO4J_URI", "bolt://example:7687")
    runtime = Runtime(RuntimePaths(tmp_path))

    environment = runtime.environment("generated")

    assert environment["NEO4J_URI"] == "bolt://example:7687"
    assert environment["NEO4J_PASSWORD"] == "generated"


def test_connection_settings_do_not_expose_unrelated_environment(
    monkeypatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "do-not-print")
    runtime = Runtime(RuntimePaths(tmp_path))

    settings = runtime.connection_settings("generated")

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
    monkeypatch.setenv("OPENAI_API_KEY", "test")
    monkeypatch.setattr("dbx_tools.graphiti.cli.Runtime.start", start)

    main(["up", "--", "--port", "9000"])

    start.assert_called_once_with(foreground=False, extra_args=["--port", "9000"])
