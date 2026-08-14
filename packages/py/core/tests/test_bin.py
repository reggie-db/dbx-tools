from __future__ import annotations

import asyncio
import os
from pathlib import Path
from unittest.mock import Mock

import pytest
from dbx_tools.core import bin


def test_resolve_prefers_existing_path(monkeypatch) -> None:
    monkeypatch.setattr(bin.shutil, "which", lambda name: f"/usr/bin/{name}")
    ensure_tool = Mock()
    monkeypatch.setattr(bin, "ensure_tool", ensure_tool)

    assert bin.resolve("python", mise_tool="python@3.12") == "/usr/bin/python"
    ensure_tool.assert_not_called()


def test_resolve_requires_mise_tool_for_missing_executable(monkeypatch) -> None:
    monkeypatch.setattr(bin.shutil, "which", lambda name: None)

    with pytest.raises(FileNotFoundError):
        bin.resolve("missing")


def test_resolve_returns_mise_which_executable(monkeypatch, tmp_path: Path) -> None:
    executable = tmp_path / "bin" / "uv"
    executable.parent.mkdir()
    executable.write_text("#!/bin/sh\n")
    executable.chmod(0o755)
    tool = bin.MiseTool(spec="uv@0.11", root=tmp_path, mise=Path("/opt/bin/mise"))
    monkeypatch.setattr(bin.shutil, "which", lambda name: None)
    monkeypatch.setattr(bin, "ensure_tool", lambda spec: tool)
    run = Mock(
        return_value=Mock(
            stdout=f"{executable}\n",
        )
    )
    monkeypatch.setattr(bin, "_run_mise", run)

    assert bin.resolve("uv", mise_tool="uv@0.11") == str(executable)
    assert run.call_args.args[:4] == (
        tool.mise,
        "which",
        "uv",
        "--tool",
    )


def test_ensure_tool_uses_check_lock_check(monkeypatch, tmp_path: Path) -> None:
    mise = tmp_path / "mise"
    root = tmp_path / "tool"
    root.mkdir()
    checks = iter([None, None, root])
    run = Mock(return_value=Mock(returncode=0))
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "cache"))
    monkeypatch.setattr(bin, "ensure_mise", lambda: mise)
    monkeypatch.setattr(bin, "_mise_where", lambda *_: next(checks))
    monkeypatch.setattr(bin, "_run_mise", run)

    installed = bin.ensure_tool("uv@0.11")

    assert installed == bin.MiseTool(spec="uv@0.11", root=root, mise=mise)
    assert run.call_args.args == (mise, "use", "-g", "--yes", "uv@0.11")


def test_ensure_mise_uses_locked_official_installer(monkeypatch, tmp_path: Path) -> None:
    destination = tmp_path / "bin" / "mise"
    findings = iter([None, None])

    def install(path: Path) -> None:
        path.parent.mkdir(parents=True)
        path.touch(mode=0o755)

    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "cache"))
    monkeypatch.setenv("MISE_INSTALL_PATH", str(destination))
    monkeypatch.setattr(bin, "_find_mise", lambda: next(findings))
    monkeypatch.setattr(bin, "_install_mise", install)
    monkeypatch.setattr(bin, "_is_mise", lambda path: path == destination)

    assert bin.ensure_mise() == destination


def test_execute_matches_asyncio_subprocess_contract(monkeypatch) -> None:
    process = object()
    create = Mock()

    async def create_subprocess_exec(*args, **kwargs):
        create(*args, **kwargs)
        return process

    monkeypatch.setattr(bin, "resolve", lambda name, **kwargs: f"/resolved/{name}")
    monkeypatch.setattr(asyncio, "create_subprocess_exec", create_subprocess_exec)

    result = asyncio.run(
        bin.execute(
            "python",
            "-c",
            "pass",
            mise_tool="python@3.12",
            stdout=asyncio.subprocess.PIPE,
            env={"EXAMPLE": "1"},
        )
    )

    assert result is process
    create.assert_called_once_with(
        "/resolved/python",
        "-c",
        "pass",
        stdout=asyncio.subprocess.PIPE,
        env={"EXAMPLE": "1"},
    )


def test_install_lock_releases_after_exception(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path))

    with pytest.raises(RuntimeError), bin._install_lock(["tool", "version"]):
        raise RuntimeError("failure")

    with bin._install_lock(["tool", "version"]):
        assert os.name
