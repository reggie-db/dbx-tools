"""Per-user service lifecycle for the Python model proxy."""

from __future__ import annotations

import argparse
import json
import os
import plistlib
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping, Sequence
from dataclasses import asdict, dataclass
from pathlib import Path

SERVICE_NAME = "dbx-tools-model-proxy"
SERVICE_LABEL = "com.dbx-tools.model-proxy"
TRAY_LABEL = f"{SERVICE_LABEL}.tray"


@dataclass(frozen=True)
class ServiceSettings:
    python: str
    server_args: list[str]
    host: str
    port: int
    systray: bool
    path: str

    @property
    def url(self) -> str:
        host = "127.0.0.1" if self.host in {"0.0.0.0", "::"} else self.host
        return f"http://{host}:{self.port}"


@dataclass(frozen=True)
class ServicePaths:
    config_dir: Path

    @property
    def settings(self) -> Path:
        return self.config_dir / "service.json"

    @property
    def service_log(self) -> Path:
        return self.config_dir / "service.log"

    @property
    def tray_log(self) -> Path:
        return self.config_dir / "tray.log"


@dataclass
class ServiceDependencies:
    platform: str
    home: Path
    python: str
    environment: Mapping[str, str]
    run: Callable[..., subprocess.CompletedProcess[str]]
    sleep: Callable[[float], None]
    healthy: Callable[[str], bool]
    uid: int

    @classmethod
    def defaults(cls) -> ServiceDependencies:
        return cls(
            platform=sys.platform,
            home=Path.home(),
            python=sys.executable,
            environment=os.environ,
            run=subprocess.run,
            sleep=time.sleep,
            healthy=_healthy,
            uid=os.getuid() if hasattr(os, "getuid") else 0,
        )


class ServiceBackend:
    def __init__(self, paths: ServicePaths, dependencies: ServiceDependencies) -> None:
        self.paths = paths
        self.dependencies = dependencies

    def install(self, settings: ServiceSettings) -> None:
        raise NotImplementedError

    def start(self, settings: ServiceSettings) -> None:
        raise NotImplementedError

    def stop(self, settings: ServiceSettings) -> None:
        raise NotImplementedError

    def uninstall(self, settings: ServiceSettings | None) -> None:
        raise NotImplementedError

    def registered(self) -> bool:
        raise NotImplementedError

    def running(self) -> bool:
        raise NotImplementedError

    def _run(
        self, command: Sequence[str], *, check: bool = True
    ) -> subprocess.CompletedProcess[str]:
        return self.dependencies.run(
            list(command),
            check=check,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )


class LaunchdBackend(ServiceBackend):
    @property
    def domain(self) -> str:
        return f"gui/{self.dependencies.uid}"

    @property
    def service_plist(self) -> Path:
        return self.dependencies.home / "Library/LaunchAgents" / f"{SERVICE_LABEL}.plist"

    @property
    def tray_plist(self) -> Path:
        return self.dependencies.home / "Library/LaunchAgents" / f"{TRAY_LABEL}.plist"

    def install(self, settings: ServiceSettings) -> None:
        self.uninstall(settings)
        _write_plist(
            self.service_plist,
            SERVICE_LABEL,
            _proxy_command(settings),
            self.paths.service_log,
            settings.path,
            keep_alive=True,
        )
        self._run(["launchctl", "bootstrap", self.domain, str(self.service_plist)])
        if settings.systray:
            _write_plist(
                self.tray_plist,
                TRAY_LABEL,
                _tray_command(settings, self.paths),
                self.paths.tray_log,
                settings.path,
                keep_alive=False,
            )
            self._run(["launchctl", "bootstrap", self.domain, str(self.tray_plist)])

    def start(self, settings: ServiceSettings) -> None:
        if not self.registered():
            self._run(["launchctl", "bootstrap", self.domain, str(self.service_plist)])
        else:
            self._run(["launchctl", "kickstart", "-k", f"{self.domain}/{SERVICE_LABEL}"])
        if settings.systray:
            tray_registered = (
                self._run(
                    ["launchctl", "print", f"{self.domain}/{TRAY_LABEL}"],
                    check=False,
                ).returncode
                == 0
            )
            if tray_registered:
                self._run(
                    ["launchctl", "kickstart", "-k", f"{self.domain}/{TRAY_LABEL}"],
                    check=False,
                )
            elif self.tray_plist.is_file():
                self._run(
                    ["launchctl", "bootstrap", self.domain, str(self.tray_plist)],
                    check=False,
                )

    def stop(self, settings: ServiceSettings) -> None:
        if settings.systray:
            self._run(["launchctl", "bootout", f"{self.domain}/{TRAY_LABEL}"], check=False)
        self._run(["launchctl", "bootout", f"{self.domain}/{SERVICE_LABEL}"], check=False)

    def uninstall(self, settings: ServiceSettings | None) -> None:
        for label, path in ((TRAY_LABEL, self.tray_plist), (SERVICE_LABEL, self.service_plist)):
            self._run(["launchctl", "bootout", f"{self.domain}/{label}"], check=False)
            path.unlink(missing_ok=True)

    def registered(self) -> bool:
        return (
            self._run(
                ["launchctl", "print", f"{self.domain}/{SERVICE_LABEL}"], check=False
            ).returncode
            == 0
        )

    def running(self) -> bool:
        result = self._run(
            ["launchctl", "print", f"{self.domain}/{SERVICE_LABEL}"],
            check=False,
        )
        return result.returncode == 0 and "state = running" in result.stdout


class SystemdBackend(ServiceBackend):
    @property
    def unit_dir(self) -> Path:
        return self.dependencies.home / ".config/systemd/user"

    @property
    def service_unit(self) -> Path:
        return self.unit_dir / f"{SERVICE_NAME}.service"

    @property
    def tray_unit(self) -> Path:
        return self.unit_dir / f"{SERVICE_NAME}-tray.service"

    def install(self, settings: ServiceSettings) -> None:
        self.uninstall(settings)
        _write_systemd_unit(
            self.service_unit,
            "dbx-tools model proxy",
            _proxy_command(settings),
            self.paths.service_log,
            settings.path,
            restart=True,
        )
        if settings.systray:
            _write_systemd_unit(
                self.tray_unit,
                "dbx-tools model proxy tray",
                _tray_command(settings, self.paths),
                self.paths.tray_log,
                settings.path,
                restart=False,
                after=f"{SERVICE_NAME}.service",
            )
        self._run(["systemctl", "--user", "daemon-reload"])
        self._run(["systemctl", "--user", "enable", "--now", self.service_unit.name])
        if settings.systray:
            self._run(["systemctl", "--user", "enable", "--now", self.tray_unit.name])

    def start(self, settings: ServiceSettings) -> None:
        self._run(["systemctl", "--user", "start", self.service_unit.name])
        if settings.systray:
            self._run(["systemctl", "--user", "start", self.tray_unit.name], check=False)

    def stop(self, settings: ServiceSettings) -> None:
        if settings.systray:
            self._run(["systemctl", "--user", "stop", self.tray_unit.name], check=False)
        self._run(["systemctl", "--user", "stop", self.service_unit.name], check=False)

    def uninstall(self, settings: ServiceSettings | None) -> None:
        for unit in (self.tray_unit, self.service_unit):
            self._run(["systemctl", "--user", "disable", "--now", unit.name], check=False)
            unit.unlink(missing_ok=True)
        self._run(["systemctl", "--user", "daemon-reload"], check=False)

    def registered(self) -> bool:
        return (
            self._run(
                ["systemctl", "--user", "is-enabled", self.service_unit.name],
                check=False,
            ).returncode
            == 0
        )

    def running(self) -> bool:
        return (
            self._run(
                ["systemctl", "--user", "is-active", self.service_unit.name],
                check=False,
            ).returncode
            == 0
        )


class WindowsBackend(ServiceBackend):
    @property
    def service_task(self) -> str:
        return r"\dbx-tools\model-proxy"

    @property
    def tray_task(self) -> str:
        return r"\dbx-tools\model-proxy-tray"

    def install(self, settings: ServiceSettings) -> None:
        self.uninstall(settings)
        service_launcher = _write_windows_launcher(
            self.paths.config_dir / "service.cmd",
            _proxy_command(settings),
            self.paths.service_log,
        )
        self._create_task(self.service_task, service_launcher)
        if settings.systray:
            tray_launcher = _write_windows_launcher(
                self.paths.config_dir / "tray.cmd",
                _tray_command(settings, self.paths),
                self.paths.tray_log,
            )
            self._create_task(self.tray_task, tray_launcher)
        self.start(settings)

    def start(self, settings: ServiceSettings) -> None:
        self._run(["schtasks", "/Run", "/TN", self.service_task])
        if settings.systray:
            self._run(["schtasks", "/Run", "/TN", self.tray_task], check=False)

    def stop(self, settings: ServiceSettings) -> None:
        if settings.systray:
            self._run(["schtasks", "/End", "/TN", self.tray_task], check=False)
        self._run(["schtasks", "/End", "/TN", self.service_task], check=False)

    def uninstall(self, settings: ServiceSettings | None) -> None:
        for task in (self.tray_task, self.service_task):
            self._run(["schtasks", "/Delete", "/TN", task, "/F"], check=False)

    def registered(self) -> bool:
        return (
            self._run(["schtasks", "/Query", "/TN", self.service_task], check=False).returncode == 0
        )

    def running(self) -> bool:
        return self.registered()

    def _create_task(self, name: str, launcher: Path) -> None:
        self._run(
            [
                "schtasks",
                "/Create",
                "/TN",
                name,
                "/TR",
                str(launcher),
                "/SC",
                "ONLOGON",
                "/RL",
                "LIMITED",
                "/F",
            ]
        )


def main(
    arguments: Sequence[str] | None = None,
    dependencies: ServiceDependencies | None = None,
) -> None:
    deps = dependencies or ServiceDependencies.defaults()
    _reject_databricks_app(deps.environment)
    parser = _parser()
    options = parser.parse_args(arguments)
    paths = ServicePaths(Path(options.config_dir).expanduser().resolve())
    backend = _backend(paths, deps)

    if options.command == "install":
        server_args = _server_args(options.server_args)
        host, port = _server_address(server_args, deps.environment)
        systray = _resolve_systray(options.systray, deps.python, paths, deps)
        paths.config_dir.mkdir(parents=True, exist_ok=True)
        settings = ServiceSettings(
            python=deps.python,
            server_args=server_args,
            host=host,
            port=port,
            systray=systray,
            path=deps.environment.get("PATH", ""),
        )
        _save(paths.settings, settings)
        backend.install(settings)
        try:
            _wait_healthy(settings.url, deps)
        except BaseException:
            backend.uninstall(settings)
            raise
        _write_status(backend, settings, deps)
        return

    settings = _load(paths.settings)
    if options.command == "start":
        backend.start(settings)
        _wait_healthy(settings.url, deps)
    elif options.command == "stop":
        backend.stop(settings)
    elif options.command == "restart":
        backend.stop(settings)
        backend.start(settings)
        _wait_healthy(settings.url, deps)
    elif options.command == "status":
        _write_status(backend, settings, deps)
        return
    elif options.command in {"uninstall", "remove"}:
        backend.uninstall(settings)
        if options.purge:
            shutil.rmtree(paths.config_dir, ignore_errors=True)
        return
    _write_status(backend, settings, deps)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="dbx-model-proxy service")
    subcommands = parser.add_subparsers(dest="command", required=True)
    install = subcommands.add_parser("install", help="Install and start the per-user service")
    install.add_argument("--config-dir", default=str(_default_config_dir(Path.home())))
    install.add_argument("--systray", choices=("auto", "always", "never"), default="auto")
    install.add_argument("server_args", nargs=argparse.REMAINDER)
    for name in ("start", "stop", "restart", "status"):
        command = subcommands.add_parser(name)
        command.add_argument("--config-dir", default=str(_default_config_dir(Path.home())))
    for name in ("uninstall", "remove"):
        command = subcommands.add_parser(name)
        command.add_argument("--config-dir", default=str(_default_config_dir(Path.home())))
        command.add_argument("--purge", action="store_true")
    return parser


def _backend(paths: ServicePaths, dependencies: ServiceDependencies) -> ServiceBackend:
    if dependencies.platform == "darwin":
        return LaunchdBackend(paths, dependencies)
    if dependencies.platform.startswith("linux"):
        return SystemdBackend(paths, dependencies)
    if dependencies.platform == "win32":
        return WindowsBackend(paths, dependencies)
    raise RuntimeError(f"service installation is unsupported on {dependencies.platform}")


def _default_config_dir(home: Path) -> Path:
    return home / ".dbx-tools/model-proxy"


def _server_args(arguments: Sequence[str]) -> list[str]:
    return list(arguments[1:] if arguments[:1] == ["--"] else arguments)


def _server_address(
    arguments: Sequence[str],
    environment: Mapping[str, str],
) -> tuple[str, int]:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument(
        "--port",
        type=int,
        default=int(environment.get("DATABRICKS_APP_PORT", "4000")),
    )
    options, _ = parser.parse_known_args(arguments)
    if not 1 <= options.port <= 65535:
        raise ValueError("port must be between 1 and 65535")
    return options.host, options.port


def _proxy_command(settings: ServiceSettings) -> list[str]:
    return [settings.python, "-m", "dbx_tools.model_proxy", *settings.server_args]


def _tray_command(settings: ServiceSettings, paths: ServicePaths) -> list[str]:
    return [
        settings.python,
        "-m",
        "dbx_tools.model_proxy.tray",
        "--url",
        settings.url,
        "--config-dir",
        str(paths.config_dir),
    ]


def _resolve_systray(
    mode: str,
    python: str,
    paths: ServicePaths,
    dependencies: ServiceDependencies,
) -> bool:
    if mode == "never":
        return False
    result = dependencies.run(
        [
            python,
            "-m",
            "dbx_tools.model_proxy.tray",
            "--probe",
            "--config-dir",
            str(paths.config_dir),
        ],
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if result.returncode == 0:
        return True
    if mode == "always":
        raise RuntimeError(result.stderr.strip() or "native systray is unavailable")
    return False


def _save(path: Path, settings: ServiceSettings) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(f"{json.dumps(asdict(settings), indent=2)}\n", encoding="utf-8")
    temporary.replace(path)


def _load(path: Path) -> ServiceSettings:
    if not path.is_file():
        raise RuntimeError(f"model proxy service is not installed: {path}")
    value = json.loads(path.read_text(encoding="utf-8"))
    return ServiceSettings(**value)


def _healthy(url: str) -> bool:
    try:
        with urllib.request.urlopen(f"{url}/api/healthz", timeout=2) as response:
            return response.status == 200
    except (OSError, urllib.error.URLError):
        return False


def _wait_healthy(url: str, dependencies: ServiceDependencies) -> None:
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if dependencies.healthy(url):
            return
        dependencies.sleep(0.25)
    raise RuntimeError(f"model proxy service did not become healthy at {url}")


def _write_status(
    backend: ServiceBackend,
    settings: ServiceSettings,
    dependencies: ServiceDependencies,
) -> None:
    print(
        json.dumps(
            {
                "registered": backend.registered(),
                "running": backend.running(),
                "healthy": dependencies.healthy(settings.url),
                "url": settings.url,
                "systray": settings.systray,
            },
            indent=2,
        )
    )


def _reject_databricks_app(environment: Mapping[str, str]) -> None:
    override = environment.get("DBX_TOOLS_DATABRICKS_APP_ENV", "").strip().lower()
    detected = override in {"1", "true", "yes", "on"} or all(
        environment.get(name)
        for name in ("DATABRICKS_APP_NAME", "DATABRICKS_HOST", "DATABRICKS_APP_PORT")
    )
    if detected:
        raise RuntimeError("host service management is unavailable inside a Databricks App")


def _write_plist(
    path: Path,
    label: str,
    command: Sequence[str],
    log: Path,
    path_environment: str,
    *,
    keep_alive: bool,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as output:
        plistlib.dump(
            {
                "Label": label,
                "ProgramArguments": list(command),
                "RunAtLoad": True,
                "KeepAlive": keep_alive,
                "ProcessType": "Interactive" if label == TRAY_LABEL else "Background",
                "EnvironmentVariables": {"PATH": path_environment},
                "StandardOutPath": str(log),
                "StandardErrorPath": str(log),
            },
            output,
        )


def _write_systemd_unit(
    path: Path,
    description: str,
    command: Sequence[str],
    log: Path,
    path_environment: str,
    *,
    restart: bool,
    after: str | None = None,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    unit = ["[Unit]", f"Description={description}"]
    if after:
        unit.extend([f"After={after}", f"Requires={after}"])
    unit.extend(
        [
            "",
            "[Service]",
            f"ExecStart={' '.join(_systemd_quote(value) for value in command)}",
            f'Environment="PATH={_systemd_escape(path_environment)}"',
            f"StandardOutput=append:{log}",
            f"StandardError=append:{log}",
            f"Restart={'on-failure' if restart else 'no'}",
            "",
            "[Install]",
            "WantedBy=default.target",
            "",
        ]
    )
    path.write_text("\n".join(unit), encoding="utf-8")


def _systemd_quote(value: str) -> str:
    return f'"{_systemd_escape(value)}"'


def _systemd_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _write_windows_launcher(path: Path, command: Sequence[str], log: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        f"@echo off\r\n{subprocess.list2cmdline(list(command))} >> {subprocess.list2cmdline([str(log)])} 2>&1\r\n",
        encoding="utf-8",
    )
    return path
