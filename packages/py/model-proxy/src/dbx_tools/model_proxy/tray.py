"""Native model-proxy systray companion."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from collections.abc import Mapping, Sequence
from importlib.resources import files
from pathlib import Path
from typing import Any

CONTROL_HEADER = "x-model-proxy-control"


class ProxyApi:
    def __init__(self, url: str) -> None:
        self.url = url.rstrip("/")

    def status(self) -> dict[str, Any]:
        return self._request("GET", "/api/auth")

    def profiles(self) -> list[dict[str, Any]]:
        payload = self._request("GET", "/api/auth/profiles")
        profiles = payload.get("profiles", [])
        return profiles if isinstance(profiles, list) else []

    def select_profile(self, profile: str) -> dict[str, Any]:
        return self._request(
            "PUT",
            "/api/auth",
            {"kind": "profile", "profile": profile},
        )

    def _request(
        self,
        method: str,
        path: str,
        payload: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        body = json.dumps(payload).encode() if payload is not None else None
        request = urllib.request.Request(
            f"{self.url}{path}",
            data=body,
            method=method,
            headers={
                "content-type": "application/json",
                "origin": self.url,
                CONTROL_HEADER: "1",
            },
        )
        with urllib.request.urlopen(request, timeout=20) as response:
            value = json.load(response)
        if not isinstance(value, dict):
            raise TypeError("model proxy returned a non-object response")
        return value


def main(arguments: Sequence[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="dbx-model-proxy-tray")
    parser.add_argument("--url", default="http://127.0.0.1:4000")
    parser.add_argument("--config-dir", default=str(Path.home() / ".dbx-tools/model-proxy"))
    parser.add_argument("--name", default="dbx-tools-model-proxy")
    parser.add_argument("--title", default="dbx-tools model proxy")
    parser.add_argument("--concurrent", action="store_true")
    parser.add_argument("--probe", action="store_true")
    options = parser.parse_args(arguments)
    run_tray(
        options.url,
        Path(options.config_dir),
        options.name,
        options.title,
        concurrent=options.concurrent,
        probe=options.probe,
    )


def run_tray(
    url: str,
    config_dir: Path,
    name: str,
    title: str,
    *,
    concurrent: bool = False,
    probe: bool = False,
) -> None:
    import pystray
    from PIL import Image

    api = ProxyApi(url)
    current = {"profile": "Loading"}
    profile_names: list[str] = []
    if not probe:
        status = _wait_for_status(api)
        runtime = status.get("runtime")
        if isinstance(runtime, Mapping) and isinstance(runtime.get("profile"), str):
            current["profile"] = runtime["profile"]
        profile_names.extend(
            profile["name"]
            for profile in api.profiles()
            if isinstance(profile, Mapping) and isinstance(profile.get("name"), str)
        )

    def select(profile: str) -> None:
        def update() -> None:
            response = api.select_profile(profile)
            runtime = response.get("runtime")
            if isinstance(runtime, Mapping) and isinstance(runtime.get("profile"), str):
                current["profile"] = runtime["profile"]
                icon.update_menu()

        threading.Thread(target=update, daemon=True).start()

    def stop_service() -> None:
        subprocess.Popen(
            [
                sys.executable,
                "-m",
                "dbx_tools.model_proxy",
                "service",
                "stop",
                "--config-dir",
                str(config_dir),
                *(["--concurrent"] if concurrent else []),
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        icon.stop()

    profiles = pystray.Menu(
        *[
            pystray.MenuItem(
                profile,
                _profile_action(select, profile),
                checked=_profile_checked(current, profile),
                radio=True,
            )
            for profile in profile_names
        ]
    )
    menu = pystray.Menu(
        pystray.MenuItem(f"Proxy: {url}", None, enabled=False),
        pystray.MenuItem(
            "Open Models",
            lambda _icon, _item: webbrowser.open(f"{url}/v1/models"),
        ),
        pystray.MenuItem(
            "Open API",
            lambda _icon, _item: webbrowser.open(f"{url}/docs"),
        ),
        pystray.MenuItem(lambda _item: f"Profile: {current['profile']}", profiles),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Stop Service", lambda _icon, _item: stop_service()),
    )
    asset = "icon.ico" if sys.platform == "win32" else "icon.png"
    icon_path = files("dbx_tools.model_proxy").joinpath(f"assets/{asset}")
    with icon_path.open("rb") as source:
        image = Image.open(source).copy()
    icon = pystray.Icon(name, image, title, menu)
    if probe:
        return
    icon.run()


def _profile_action(select: Any, profile: str) -> Any:
    def action(_icon: Any, _item: Any) -> None:
        select(profile)

    return action


def _profile_checked(current: Mapping[str, str], profile: str) -> Any:
    def checked(_item: Any) -> bool:
        return current.get("profile") == profile

    return checked


def _wait_for_status(
    api: ProxyApi,
    *,
    attempts: int = 120,
    sleep: Any = time.sleep,
) -> dict[str, Any]:
    for attempt in range(attempts):
        try:
            return api.status()
        except (OSError, urllib.error.URLError):
            if attempt + 1 == attempts:
                raise
            sleep(0.25)
    raise RuntimeError("model proxy status retry loop did not run")


if __name__ == "__main__":
    main()
