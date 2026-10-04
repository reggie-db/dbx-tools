from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

import pytest
from dbx_tools.model_proxy import service


class FakeRunner:
    def __init__(self) -> None:
        self.commands: list[list[str]] = []
        self.launchd_labels: set[str] = set()

    def __call__(self, command: list[str], **_: Any) -> subprocess.CompletedProcess[str]:
        self.commands.append(command)
        if command[:2] == ["launchctl", "bootstrap"]:
            self.launchd_labels.add(Path(command[-1]).stem)
        elif command[:2] == ["launchctl", "bootout"]:
            self.launchd_labels.discard(command[-1].rsplit("/", 1)[-1])
        elif command[:2] == ["launchctl", "print"]:
            registered = command[-1].rsplit("/", 1)[-1] in self.launchd_labels
            return subprocess.CompletedProcess(
                command,
                0 if registered else 1,
                "state = running" if registered else "",
                "",
            )
        return subprocess.CompletedProcess(command, 0, "", "")


def dependencies(tmp_path: Path, runner: FakeRunner, platform: str) -> service.ServiceDependencies:
    return service.ServiceDependencies(
        platform=platform,
        home=tmp_path,
        python="/runtime/python",
        environment={"PATH": "/usr/bin"},
        run=runner,
        sleep=lambda _: None,
        healthy=lambda _: True,
        uid=501,
    )


def test_systemd_install_writes_proxy_and_tray_units(tmp_path: Path, capsys: Any) -> None:
    runner = FakeRunner()
    config_dir = tmp_path / "config"

    service.main(
        [
            "install",
            "--config-dir",
            str(config_dir),
            "--systray",
            "always",
            "--",
            "--profile",
            "TEST",
            "--port",
            "4100",
        ],
        dependencies(tmp_path, runner, "linux"),
    )

    unit = tmp_path / ".config/systemd/user/dbx-tools-model-proxy.service"
    tray = tmp_path / ".config/systemd/user/dbx-tools-model-proxy-tray.service"
    assert 'ExecStart="/runtime/python" "-m" "dbx_tools.model_proxy"' in unit.read_text()
    assert '"--profile" "TEST" "--port" "4100"' in unit.read_text()
    assert "dbx_tools.model_proxy.tray" in tray.read_text()
    assert json.loads(capsys.readouterr().out)["healthy"] is True
    assert ["systemctl", "--user", "enable", "--now", unit.name] in runner.commands


def test_launchd_install_writes_user_agents(tmp_path: Path, capsys: Any) -> None:
    runner = FakeRunner()
    config_dir = tmp_path / "config"

    service.main(
        ["install", "--config-dir", str(config_dir), "--systray", "never"],
        dependencies(tmp_path, runner, "darwin"),
    )

    plist = tmp_path / "Library/LaunchAgents/com.dbx-tools.model-proxy.plist"
    assert plist.is_file()
    assert not (tmp_path / "Library/LaunchAgents/com.dbx-tools.model-proxy.tray.plist").exists()
    assert json.loads(capsys.readouterr().out)["systray"] is False

    service.main(
        ["stop", "--config-dir", str(config_dir)],
        dependencies(tmp_path, runner, "darwin"),
    )
    service.main(
        ["start", "--config-dir", str(config_dir)],
        dependencies(tmp_path, runner, "darwin"),
    )
    service.main(
        ["restart", "--config-dir", str(config_dir)],
        dependencies(tmp_path, runner, "darwin"),
    )
    assert ["launchctl", "bootstrap", "gui/501", str(plist)] in runner.commands


def test_service_rejects_databricks_app(tmp_path: Path) -> None:
    runner = FakeRunner()
    deps = dependencies(tmp_path, runner, "linux")
    deps.environment = {"DBX_TOOLS_DATABRICKS_APP_ENV": "true"}

    with pytest.raises(RuntimeError, match="Databricks App"):
        service.main(["status"], deps)


def test_concurrent_service_uses_independent_identity_and_port(
    tmp_path: Path,
    capsys: Any,
) -> None:
    runner = FakeRunner()

    service.main(
        ["install", "--concurrent", "--systray", "always"],
        dependencies(tmp_path, runner, "linux"),
    )

    config_dir = tmp_path / ".dbx-tools/model-proxy-python"
    unit = tmp_path / ".config/systemd/user/dbx-tools-model-proxy-python.service"
    tray = tmp_path / ".config/systemd/user/dbx-tools-model-proxy-python-tray.service"
    settings = json.loads((config_dir / "service.json").read_text())
    status = json.loads(capsys.readouterr().out)
    assert settings["server_args"] == ["--port", "4001"]
    assert settings["concurrent"] is True
    assert status["url"] == "http://127.0.0.1:4001"
    assert unit.is_file()
    assert tray.is_file()
    assert "dbx-tools-model-proxy-python" in tray.read_text()
    assert '"--concurrent"' in tray.read_text()
