from __future__ import annotations

import os
import sys
import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any, TypeVar

"""Cross-process file locks and platform cache paths."""

_T = TypeVar("_T")
_LOCKS_GUARD = threading.Lock()
_THREAD_LOCKS: dict[Path, threading.RLock] = {}


def platform_cache_root() -> Path:
    """Return the platform cache root, honoring ``XDG_CACHE_HOME``."""
    configured = os.getenv("XDG_CACHE_HOME")
    if configured:
        return Path(configured).expanduser()
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Caches"
    if os.name == "nt":
        return Path(os.getenv("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    return Path.home() / ".cache"


@contextmanager
def file_lock(path: str | os.PathLike[str]) -> Iterator[None]:
    """Hold a process-local and operating-system lock for ``path``."""
    resolved = Path(path).expanduser().resolve()
    resolved.parent.mkdir(parents=True, exist_ok=True)
    with _LOCKS_GUARD:
        thread_lock = _THREAD_LOCKS.setdefault(resolved, threading.RLock())
    with thread_lock, resolved.open("a+b") as handle:
        _lock_file(handle)
        try:
            yield
        finally:
            _unlock_file(handle)


def check_lock_check(
    path: str | os.PathLike[str],
    check: Callable[[], _T | None],
    load: Callable[[], _T],
) -> _T:
    """Return a cached value or load it once under a cross-process lock."""
    value = check()
    if value is not None:
        return value
    with file_lock(path):
        value = check()
        return value if value is not None else load()


def _lock_file(handle: Any) -> None:
    """Acquire an operating-system lock for an open lock file."""
    if os.name == "nt":
        import msvcrt

        handle.seek(0)
        if handle.read(1) != b"\0":
            handle.seek(0)
            handle.write(b"\0")
            handle.flush()
        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
        return
    import fcntl

    fcntl.flock(handle.fileno(), fcntl.LOCK_EX)


def _unlock_file(handle: Any) -> None:
    """Release an operating-system lock for an open lock file."""
    if os.name == "nt":
        import msvcrt

        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        return
    import fcntl

    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
