from __future__ import annotations

import inspect

from dbx_tools.model_proxy.tray import _profile_action, _profile_checked, _wait_for_status


def test_profile_callbacks_match_pystray_signatures() -> None:
    selected: list[str] = []
    action = _profile_action(selected.append, "PROFILE")
    checked = _profile_checked({"profile": "PROFILE"}, "PROFILE")

    assert len(inspect.signature(action).parameters) == 2
    assert len(inspect.signature(checked).parameters) == 1
    action(None, None)
    assert selected == ["PROFILE"]
    assert checked(None) is True


def test_tray_waits_for_proxy_startup() -> None:
    attempts = 0
    sleeps: list[float] = []

    class Api:
        def status(self) -> dict[str, bool]:
            nonlocal attempts
            attempts += 1
            if attempts < 3:
                raise ConnectionRefusedError
            return {"ready": True}

    assert _wait_for_status(Api(), attempts=3, sleep=sleeps.append) == {"ready": True}  # type: ignore[arg-type]
    assert sleeps == [0.25, 0.25]
