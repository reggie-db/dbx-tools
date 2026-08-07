from __future__ import annotations

import subprocess
from collections.abc import Sequence

import dbx_tools.litellm.backend as backend_module
import dbx_tools.litellm.cli as cli_module
import pytest
from dbx_tools.litellm.backend import DATABRICKS_PROFILE_ENV, require_profile


def test_explicit_profile_wins_without_spawning_cli(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        backend_module.subprocess,
        "run",
        lambda *args, **kwargs: pytest.fail(f"unexpected CLI spawn: {args}, {kwargs}"),
    )

    assert require_profile("  explicit  ", environ={DATABRICKS_PROFILE_ENV: "environment"}) == (
        "explicit"
    )


def test_environment_profile_wins_without_spawning_cli(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        backend_module.subprocess,
        "run",
        lambda *args, **kwargs: pytest.fail(f"unexpected CLI spawn: {args}, {kwargs}"),
    )

    assert require_profile(environ={DATABRICKS_PROFILE_ENV: "  environment  "}) == "environment"


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


def test_cli_profile_argument_is_optional(monkeypatch: pytest.MonkeyPatch) -> None:
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
