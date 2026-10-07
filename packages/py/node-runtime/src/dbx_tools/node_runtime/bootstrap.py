from __future__ import annotations

import hashlib
import importlib
import importlib.metadata
import importlib.util
import os
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from threading import RLock
from types import ModuleType

"""Install and load the locked PythonMonkey runtime in managed Python environments."""

_LOCK_DIRECTORY_ENVIRONMENT = "DBX_TOOLS_NODE_RUNTIME_LOCK_DIRECTORY"
_NODEJS_WHEEL_REQUIREMENT = "nodejs-wheel>=22.20,<23"
_PYTHONMONKEY_VERSION = "1.3.2"
_PROCESS_LOCK = RLock()
_PROCESS_RUNTIME: ModuleType | None = None


@dataclass(frozen=True)
class NodeEnvironment:
    """Resolved Node.js files and executable launcher directory."""

    package_root: Path
    launcher_directory: Path
    node: Path
    npm_cli: Path


def runtime_lock_directory() -> Path:
    """Return the directory used only for cross-process installation locks."""

    configured = os.environ.get(_LOCK_DIRECTORY_ENVIRONMENT)
    if configured:
        return Path(configured).expanduser().resolve()
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Caches"
    else:
        base = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
    return base / "dbx-tools" / "node-runtime" / "locks"


def _environment_key() -> str:
    identity = f"{Path(sys.prefix).resolve()}\0{Path(sys.executable).resolve()}"
    return hashlib.sha256(identity.encode()).hexdigest()[:16]


def _lock_path(name: str, directory: str | Path | None = None) -> Path:
    root = (
        Path(directory).expanduser().resolve()
        if directory is not None
        else runtime_lock_directory()
    )
    return root / f"{_environment_key()}-{name}.lock"


def _distribution_version(name: str) -> str | None:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None


def _environment_pythonmonkey() -> ModuleType | None:
    loaded = sys.modules.get("pythonmonkey")
    if loaded is not None:
        version = getattr(loaded, "__version__", None)
        if version != _PYTHONMONKEY_VERSION:
            raise RuntimeError(
                f"PythonMonkey {version or 'with an unknown version'} is already loaded; "
                f"dbx-tools-node-runtime requires {_PYTHONMONKEY_VERSION}"
            )
        importlib.import_module("pythonmonkey.require")
        return loaded
    if _distribution_version("pythonmonkey") != _PYTHONMONKEY_VERSION:
        return None
    module = importlib.import_module("pythonmonkey")
    importlib.import_module("pythonmonkey.require")
    return module


@contextmanager
def _file_lock(path: Path) -> Iterator[None]:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = path.open("a+b")
    try:
        if os.name == "nt":
            import msvcrt

            if path.stat().st_size == 0:
                handle.write(b"0")
                handle.flush()
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        yield
    finally:
        if os.name == "nt":
            import msvcrt

            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        handle.close()


def _nodejs_wheel_root() -> Path | None:
    importlib.invalidate_caches()
    spec = importlib.util.find_spec("nodejs_wheel")
    if spec is None or spec.origin is None:
        return None
    return Path(spec.origin).resolve().parent


def _write_posix_launcher(path: Path, command: Sequence[Path | str]) -> None:
    arguments = " ".join(shlex.quote(str(argument)) for argument in command)
    path.write_text(f'#!/bin/sh\nexec {arguments} "$@"\n', encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def _write_windows_launcher(path: Path, command: Sequence[Path | str]) -> None:
    arguments = " ".join(f'"{argument}"' for argument in command)
    path.write_text(f"@echo off\r\n{arguments} %*\r\n", encoding="utf-8")


def prepare_node_environment(
    directory: str | Path | None = None,
    *,
    package_root: str | Path | None = None,
) -> NodeEnvironment:
    """Create direct Node and npm launchers backed by `nodejs-wheel` files."""

    resolved_root = (
        Path(package_root).resolve() if package_root is not None else _nodejs_wheel_root()
    )
    if resolved_root is None:
        raise RuntimeError(
            "nodejs-wheel is unavailable; call ensure_pythonmonkey() to install the locked runtime"
        )
    node = resolved_root / "bin" / ("node.exe" if os.name == "nt" else "node")
    npm_cli = resolved_root / "lib" / "node_modules" / "npm" / "bin" / "npm-cli.js"
    for required in (node, npm_cli):
        if not required.is_file():
            raise RuntimeError(f"nodejs-wheel is missing required file: {required}")

    launcher_directory = (
        Path(directory).resolve()
        if directory is not None
        else Path(tempfile.mkdtemp(prefix="dbx-tools-node-launchers-"))
    )
    launcher_directory.mkdir(parents=True, exist_ok=True)
    if os.name == "nt":
        _write_windows_launcher(launcher_directory / "node.cmd", [node])
        _write_windows_launcher(launcher_directory / "npm.cmd", [node, npm_cli])
    else:
        _write_posix_launcher(launcher_directory / "node", [node])
        _write_posix_launcher(launcher_directory / "npm", [node, npm_cli])
    return NodeEnvironment(
        package_root=resolved_root,
        launcher_directory=launcher_directory,
        node=node,
        npm_cli=npm_cli,
    )


@contextmanager
def node_environment(
    directory: str | Path | None = None,
    *,
    package_root: str | Path | None = None,
) -> Iterator[NodeEnvironment]:
    """Temporarily prepend direct Node and npm launchers to `PATH`."""

    temporary = directory is None
    environment = prepare_node_environment(directory, package_root=package_root)
    previous = os.environ.get("PATH")
    os.environ["PATH"] = os.pathsep.join(
        value for value in (str(environment.launcher_directory), previous) if value
    )
    try:
        yield environment
    finally:
        if previous is None:
            os.environ.pop("PATH", None)
        else:
            os.environ["PATH"] = previous
        if temporary:
            shutil.rmtree(environment.launcher_directory, ignore_errors=True)


def _pip_install(
    requirement: str,
    *,
    environment: Mapping[str, str] | None = None,
    only_binary: Sequence[str] = (),
) -> None:
    command = [
        sys.executable,
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
        "--no-input",
    ]
    if only_binary:
        command.extend(["--only-binary", ",".join(only_binary)])
    command.append(requirement)
    result = subprocess.run(
        command,
        check=False,
        env=dict(environment) if environment is not None else None,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"Could not install locked runtime requirement {requirement} "
            f"into {sys.prefix}:\n{result.stdout}"
        )
    importlib.invalidate_caches()


def _npm_available() -> bool:
    return shutil.which("npm") is not None


def _ensure_nodejs_wheel(lock_directory: str | Path | None = None) -> Path | None:
    if _npm_available():
        return None
    package_root = _nodejs_wheel_root()
    if package_root is not None:
        return package_root

    with _file_lock(_lock_path("nodejs-wheel", lock_directory)):
        if _npm_available():
            return None
        package_root = _nodejs_wheel_root()
        if package_root is None:
            _pip_install(
                _NODEJS_WHEEL_REQUIREMENT,
                only_binary=("nodejs-wheel", "nodejs-wheel-binaries"),
            )
            package_root = _nodejs_wheel_root()
        if package_root is None:
            raise RuntimeError(
                "The locked nodejs-wheel installation did not provide its package files"
            )
        return package_root


@contextmanager
def _pythonmonkey_install_environment(
    lock_directory: str | Path | None = None,
) -> Iterator[Mapping[str, str] | None]:
    package_root = _ensure_nodejs_wheel(lock_directory)
    if package_root is None:
        yield None
        return

    launcher_directory = Path(tempfile.mkdtemp(prefix="dbx-tools-node-launchers-"))
    try:
        launchers = prepare_node_environment(
            launcher_directory,
            package_root=package_root,
        )
        environment = dict(os.environ)
        environment["PATH"] = os.pathsep.join(
            value for value in (str(launchers.launcher_directory), environment.get("PATH")) if value
        )
        yield environment
    finally:
        shutil.rmtree(launcher_directory, ignore_errors=True)


def _verify_runtime() -> None:
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            (
                "import pythonmonkey as pm; import pythonmonkey.require; "
                "assert pm.eval('1 + 2') == 3; assert callable(pm.require)"
            ),
        ],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"Installed PythonMonkey runtime failed verification:\n{result.stdout}")


def ensure_pythonmonkey(lock_directory: str | Path | None = None) -> ModuleType:
    """Return PythonMonkey, installing its locked version into the active environment."""

    global _PROCESS_RUNTIME
    with _PROCESS_LOCK:
        if _PROCESS_RUNTIME is not None:
            return _PROCESS_RUNTIME
        environment_runtime = _environment_pythonmonkey()
        if environment_runtime is not None:
            _PROCESS_RUNTIME = environment_runtime
            return environment_runtime

        with _file_lock(_lock_path("pythonmonkey", lock_directory)):
            environment_runtime = _environment_pythonmonkey()
            if environment_runtime is None:
                with _pythonmonkey_install_environment(lock_directory) as environment:
                    _pip_install(
                        f"pythonmonkey=={_PYTHONMONKEY_VERSION}",
                        environment=environment,
                        only_binary=("pythonmonkey",),
                    )
                _verify_runtime()
                environment_runtime = _environment_pythonmonkey()
            if environment_runtime is None:
                raise RuntimeError(
                    "The locked PythonMonkey installation is unavailable in the active "
                    f"Python environment {sys.prefix}"
                )
            _PROCESS_RUNTIME = environment_runtime
            return environment_runtime
