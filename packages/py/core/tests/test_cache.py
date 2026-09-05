from __future__ import annotations

from pathlib import Path

from dbx_tools.core.cache import check_lock_check, file_lock, platform_cache_root


def test_platform_cache_root_honors_xdg(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path))

    assert platform_cache_root() == tmp_path


def test_check_lock_check_reuses_value_loaded_before_lock(tmp_path: Path) -> None:
    checks = iter([None, "cached"])

    result = check_lock_check(
        tmp_path / "state.lock",
        lambda: next(checks),
        lambda: "loaded",
    )

    assert result == "cached"


def test_file_lock_releases_after_exception(tmp_path: Path) -> None:
    lock = tmp_path / "state.lock"

    try:
        with file_lock(lock):
            raise RuntimeError("failure")
    except RuntimeError:
        pass

    with file_lock(lock):
        assert lock.exists()
