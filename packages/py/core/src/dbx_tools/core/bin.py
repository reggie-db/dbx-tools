from __future__ import annotations

import asyncio
import errno
import hashlib
import logging
import os
import shutil
import subprocess
import tempfile
import threading
import urllib.request
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

"""Locked mise-backed executable installation and async process creation."""

from .cache import file_lock, platform_cache_root

Executable = str | bytes | os.PathLike[str] | os.PathLike[bytes]

_INSTALLER_URL = "https://mise.run"
_LOGGER = logging.getLogger(__name__)
_THREAD_LOCK = threading.RLock()


@dataclass(frozen=True, slots=True)
class MiseTool:
    """One mise-managed tool installation."""

    spec: str
    root: Path
    mise: Path


def resolve(name: str, *, mise_tool: str | None = None) -> str:
    """Resolve an executable from PATH or install and resolve it through mise."""
    if not name:
        raise ValueError("name must not be empty")
    executable = shutil.which(name)
    if executable:
        return executable
    if not mise_tool:
        raise FileNotFoundError(errno.ENOENT, os.strerror(errno.ENOENT), name)
    tool = ensure_tool(mise_tool)
    result = _run_mise(
        tool.mise,
        "which",
        name,
        "--tool",
        mise_tool,
        check=True,
        capture_output=True,
        text=True,
    )
    executable = result.stdout.strip()
    if not executable or not _is_executable(Path(executable)):
        raise FileNotFoundError(
            errno.ENOENT,
            f"mise tool {mise_tool!r} did not provide executable {name!r}",
            name,
        )
    return executable


def ensure_tool(mise_tool: str) -> MiseTool:
    """Return an installed mise tool after a check-lock-check installation."""
    if not mise_tool:
        raise ValueError("mise_tool must not be empty")
    mise = ensure_mise()
    root = _mise_where(mise, mise_tool)
    if root is not None:
        return MiseTool(spec=mise_tool, root=root, mise=mise)
    with _install_lock(["mise-use-global"]):
        root = _mise_where(mise, mise_tool)
        if root is None:
            _LOGGER.info("Installing mise tool %s", mise_tool)
            _run_mise(mise, "use", "-g", "--yes", mise_tool, check=True)
            root = _mise_where(mise, mise_tool)
        if root is None:
            raise RuntimeError(f"mise installed {mise_tool!r} but did not report its path")
        return MiseTool(spec=mise_tool, root=root, mise=mise)


def ensure_mise() -> Path:
    """Return mise from PATH or install its official binary under a lock."""
    executable = _find_mise()
    if executable is not None:
        return executable
    destination = _mise_install_path()
    with _install_lock(["mise", str(destination)]):
        executable = _find_mise()
        if executable is not None:
            return executable
        if os.name == "nt":
            raise RuntimeError("mise is not installed; install it with `winget install jdx.mise`")
        _install_mise(destination)
        if not _is_mise(destination):
            raise RuntimeError(f"mise installation is not executable: {destination}")
        return destination


async def execute(
    program: Executable,
    *args: Executable,
    mise_tool: str | None = None,
    **kwargs: Any,
) -> asyncio.subprocess.Process:
    """Create an asyncio subprocess after optional mise-backed resolution."""
    executable = await asyncio.to_thread(resolve, os.fsdecode(program), mise_tool=mise_tool)
    return await asyncio.create_subprocess_exec(executable, *args, **kwargs)


def _find_mise() -> Path | None:
    """Find a working mise executable without changing the system."""
    candidates = [shutil.which("mise"), str(_mise_install_path())]
    for candidate in candidates:
        if candidate and _is_mise(Path(candidate)):
            return Path(candidate)
    return None


def _mise_install_path() -> Path:
    """Return the official installer destination unless explicitly overridden."""
    configured = os.getenv("MISE_INSTALL_PATH")
    return Path(configured).expanduser() if configured else Path.home() / ".local" / "bin" / "mise"


def _install_mise(destination: Path) -> None:
    """Run the official checksum-verifying installer into an atomic staging path."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(
        _INSTALLER_URL,
        headers={"User-Agent": "dbx-tools-core"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        installer = response.read()
    with tempfile.TemporaryDirectory(
        prefix="dbx-tools-mise-",
        dir=destination.parent,
    ) as temporary:
        staged = Path(temporary) / "mise"
        environment = os.environ.copy()
        environment.update(
            {
                "MISE_INSTALL_PATH": str(staged),
                "MISE_QUIET": "1",
            }
        )
        subprocess.run(
            ["sh"],
            input=installer,
            env=environment,
            check=True,
            capture_output=True,
        )
        if not _is_mise(staged):
            raise RuntimeError("official mise installer produced no valid executable")
        staged.replace(destination)
        destination.chmod(0o755)


def _mise_where(mise: Path, mise_tool: str) -> Path | None:
    """Return an installed tool root without triggering installation."""
    result = _run_mise(
        mise,
        "where",
        mise_tool,
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode:
        return None
    value = result.stdout.strip()
    if not value:
        return None
    root = Path(value)
    return root if root.exists() else None


def _run_mise(mise: Path, *args: str, **kwargs: Any) -> subprocess.CompletedProcess[Any]:
    """Run mise non-interactively while preserving normal subprocess options."""
    environment = os.environ.copy()
    environment.update(kwargs.pop("env", {}))
    environment["MISE_YES"] = "1"
    check = kwargs.pop("check", False)
    return subprocess.run([str(mise), *args], env=environment, check=check, **kwargs)


def _is_mise(path: Path) -> bool:
    """Return whether a path is an executable mise binary."""
    if not _is_executable(path):
        return False
    try:
        result = subprocess.run(
            [str(path), "--version"],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except OSError:
        return False
    return result.returncode == 0


def _is_executable(path: Path) -> bool:
    """Return whether a path is a regular executable file."""
    return path.is_file() and (os.name == "nt" or os.access(path, os.X_OK))


@contextmanager
def _install_lock(parts: list[str]) -> Iterator[None]:
    """Serialize installations across threads and Python processes."""
    digest = hashlib.sha256("\0".join(parts).encode()).hexdigest()
    lock_root = platform_cache_root() / "dbx-tools" / "bin-locks"
    path = lock_root / f"{digest}.lock"
    with _THREAD_LOCK, file_lock(path):
        yield
