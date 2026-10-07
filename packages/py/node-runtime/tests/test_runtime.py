from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from types import ModuleType

import pytest
from dbx_tools.node_runtime import bootstrap
from dbx_tools.node_runtime.__main__ import _run_javascript


def _fake_nodejs_wheel(tmp_path: Path) -> Path:
    package_root = tmp_path / "nodejs_wheel"
    (package_root / "bin").mkdir(parents=True)
    (package_root / "lib" / "node_modules" / "npm" / "bin").mkdir(parents=True)
    (package_root / "bin" / ("node.exe" if os.name == "nt" else "node")).write_text("")
    (package_root / "lib" / "node_modules" / "npm" / "bin" / "npm-cli.js").write_text("")
    return package_root


@pytest.fixture(autouse=True)
def reset_process_runtime(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(bootstrap, "_PROCESS_RUNTIME", None)


def test_prepare_node_environment_uses_direct_launchers(tmp_path: Path) -> None:
    package_root = _fake_nodejs_wheel(tmp_path)

    environment = bootstrap.prepare_node_environment(
        tmp_path / "launchers",
        package_root=package_root,
    )

    node_launcher = environment.launcher_directory / ("node.cmd" if os.name == "nt" else "node")
    npm_launcher = environment.launcher_directory / ("npm.cmd" if os.name == "nt" else "npm")
    assert node_launcher.is_file()
    assert npm_launcher.is_file()
    assert str(environment.node) in node_launcher.read_text()
    assert str(environment.npm_cli) in npm_launcher.read_text()


def test_pip_install_targets_the_active_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[list[str]] = []

    def run(command: list[str], **_: object) -> subprocess.CompletedProcess[str]:
        calls.append(command)
        return subprocess.CompletedProcess(command, 0, stdout="")

    monkeypatch.setattr(bootstrap.subprocess, "run", run)

    bootstrap._pip_install("example==1.0", only_binary=("example",))

    assert calls == [
        [
            sys.executable,
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            "--no-input",
            "--only-binary",
            "example",
            "example==1.0",
        ]
    ]
    assert "--target" not in calls[0]


def test_nodejs_wheel_is_skipped_when_npm_is_on_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(bootstrap, "_npm_available", lambda: True)

    def unexpected_install(*_: object, **__: object) -> None:
        raise AssertionError("nodejs-wheel should not be installed when npm is available")

    monkeypatch.setattr(bootstrap, "_pip_install", unexpected_install)

    assert bootstrap._ensure_nodejs_wheel() is None


def test_runtime_install_uses_check_lock_check_and_launcher_path(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    package_root = _fake_nodejs_wheel(tmp_path)
    pythonmonkey = ModuleType("pythonmonkey")
    pythonmonkey.__version__ = bootstrap._PYTHONMONKEY_VERSION
    runtime_checks = iter([None, None, pythonmonkey])
    node_checks = iter([None, None, package_root])
    npm_checks = iter([False, False])
    installs: list[tuple[str, dict[str, str] | None, tuple[str, ...]]] = []
    verified: list[bool] = []

    monkeypatch.setattr(
        bootstrap,
        "_environment_pythonmonkey",
        lambda: next(runtime_checks),
    )
    monkeypatch.setattr(bootstrap, "_nodejs_wheel_root", lambda: next(node_checks))
    monkeypatch.setattr(bootstrap, "_npm_available", lambda: next(npm_checks))

    def install(
        requirement: str,
        *,
        environment: dict[str, str] | None = None,
        only_binary: tuple[str, ...] = (),
    ) -> None:
        installs.append((requirement, environment, only_binary))

    monkeypatch.setattr(bootstrap, "_pip_install", install)
    monkeypatch.setattr(bootstrap, "_verify_runtime", lambda: verified.append(True))

    result = bootstrap.ensure_pythonmonkey(tmp_path / "locks")

    assert result is pythonmonkey
    assert installs[0] == (
        bootstrap._NODEJS_WHEEL_REQUIREMENT,
        None,
        ("nodejs-wheel", "nodejs-wheel-binaries"),
    )
    pythonmonkey_requirement, environment, only_binary = installs[1]
    assert pythonmonkey_requirement == f"pythonmonkey=={bootstrap._PYTHONMONKEY_VERSION}"
    assert environment is not None
    assert Path(environment["PATH"].split(os.pathsep)[0]).name.startswith(
        "dbx-tools-node-launchers-"
    )
    assert only_binary == ("pythonmonkey",)
    assert verified == [True]
    lock_names = {path.name for path in (tmp_path / "locks").iterdir()}
    assert any(name.endswith("-nodejs-wheel.lock") for name in lock_names)
    assert any(name.endswith("-pythonmonkey.lock") for name in lock_names)


def test_runtime_lock_directory_uses_environment_override(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configured = tmp_path / "runtime-locks"
    monkeypatch.setenv("DBX_TOOLS_NODE_RUNTIME_LOCK_DIRECTORY", str(configured))

    assert bootstrap.runtime_lock_directory() == configured.resolve()


def test_run_javascript_requires_the_resolved_file(tmp_path: Path) -> None:
    javascript = tmp_path / "hello.js"
    javascript.write_text("module.exports = 'hello';")
    required: list[str] = []

    class Runtime:
        def require(self, path: str) -> str:
            required.append(path)
            return "hello"

    assert _run_javascript(Runtime(), javascript) == "hello"
    assert required == [str(javascript.resolve())]
