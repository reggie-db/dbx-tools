from __future__ import annotations

import json
import os
import secrets
import shutil
import signal
import subprocess
import sys
import tarfile
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from .settings import ModelSettings

"""Installation and native process lifecycle for Graphiti, LiteLLM, and Neo4j."""

GRAPHITI_VERSION = "0.29.3"
NEO4J_VERSION = "5.26.12"
JAVA_VERSION = "21"
UV_VERSION = "0.11"


def default_data_dir() -> Path:
    """Return the per-user directory containing downloads, data, and logs."""
    override = os.getenv("DBX_GRAPHITI_HOME")
    if override:
        return Path(override).expanduser()
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "dbx-tools" / "graphiti"
    if os.name == "nt":
        return (
            Path(os.getenv("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
            / "dbx-tools"
            / "graphiti"
        )
    return (
        Path(os.getenv("XDG_DATA_HOME", Path.home() / ".local" / "share"))
        / "dbx-tools"
        / "graphiti"
    )


@dataclass(frozen=True)
class RuntimePaths:
    """Resolved filesystem layout for one Graphiti installation."""

    root: Path

    @classmethod
    def default(cls) -> RuntimePaths:
        return cls(default_data_dir())

    @property
    def graphiti(self) -> Path:
        return self.root / "graphiti" / GRAPHITI_VERSION

    @property
    def neo4j(self) -> Path:
        return self.root / "neo4j" / NEO4J_VERSION

    @property
    def neo4j_data(self) -> Path:
        return self.root / "data" / "neo4j"

    @property
    def state(self) -> Path:
        return self.root / "state.json"

    @property
    def log(self) -> Path:
        return self.root / "graphiti.log"

    @property
    def litellm_log(self) -> Path:
        return self.root / "litellm.log"


class Runtime:
    """Provision and run a pinned native Graphiti stack."""

    def __init__(self, paths: RuntimePaths | None = None) -> None:
        self.paths = paths or RuntimePaths.default()

    def setup(self) -> None:
        self._require_mise()
        self._ensure_mise_tool("java", JAVA_VERSION)
        self._ensure_mise_tool("uv", UV_VERSION)
        self.paths.root.mkdir(parents=True, exist_ok=True)
        self._install_neo4j()
        self._install_graphiti()
        self._ensure_state()

    def start(
        self,
        *,
        foreground: bool = True,
        extra_args: list[str] | None = None,
        settings: ModelSettings | None = None,
    ) -> int:
        settings = settings or ModelSettings.resolve()
        self.setup()
        state = self.read_state()
        self._start_neo4j(state["neo4j_password"])
        owns_litellm = self._start_litellm(settings, state)
        command = self.graphiti_command(settings, extra_args or [])
        environment = self.environment(state["neo4j_password"], settings)
        if foreground:
            try:
                return subprocess.call(
                    command,
                    cwd=self.paths.graphiti / "mcp_server",
                    env=environment,
                )
            finally:
                if owns_litellm:
                    self._stop_litellm(state)
        try:
            with self.paths.log.open("ab") as output:
                process = subprocess.Popen(
                    command,
                    cwd=self.paths.graphiti / "mcp_server",
                    env=environment,
                    stdout=output,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                )
        except Exception:
            if owns_litellm:
                self._stop_litellm(state)
            raise
        state["graphiti_pid"] = process.pid
        state["model_settings"] = settings.public_settings()
        self._write_state(state)
        return process.pid

    def stop(self) -> None:
        state = self.read_state(required=False)
        pid = state.pop("graphiti_pid", None)
        _terminate_pid(pid)
        self._stop_litellm(state)
        if (self.paths.neo4j / "bin" / "neo4j").exists():
            self._neo4j_command("stop", check=False)
        if state:
            self._write_state(state)

    def status(self) -> dict[str, object]:
        state = self.read_state(required=False)
        pid = state.get("graphiti_pid")
        model_settings = state.get("model_settings")
        manages_litellm = (
            model_settings.get("manage_litellm") if isinstance(model_settings, dict) else None
        )
        neo4j_running = False
        if (self.paths.neo4j / "bin" / "neo4j").exists():
            result = self._neo4j_command("status", check=False, capture_output=True)
            neo4j_running = result.returncode == 0
        return {
            "home": str(self.paths.root),
            "graphiti": "running" if isinstance(pid, int) and _is_running(pid) else "stopped",
            "graphiti_pid": pid,
            "neo4j": "running" if neo4j_running else "stopped",
            "mcp_url": (
                f"http://{os.getenv('GRAPHITI_HOST', '127.0.0.1')}:"
                f"{os.getenv('GRAPHITI_PORT', '8000')}/mcp/"
            ),
            "litellm": (
                "running"
                if isinstance(state.get("litellm_pid"), int) and _is_running(state["litellm_pid"])
                else "external"
                if manages_litellm is False
                else "stopped"
            ),
            "litellm_pid": state.get("litellm_pid"),
            "models": model_settings,
        }

    def graphiti_command(self, settings: ModelSettings, extra_args: list[str]) -> list[str]:
        """Build the upstream command entirely from defaults, environment, and CLI flags."""
        return [
            "mise",
            "exec",
            f"uv@{UV_VERSION}",
            "--",
            "uv",
            "run",
            "--project",
            str(self.paths.graphiti / "mcp_server"),
            "python",
            str(self.paths.graphiti / "mcp_server" / "main.py"),
            "--host",
            os.getenv("GRAPHITI_HOST", "127.0.0.1"),
            "--port",
            os.getenv("GRAPHITI_PORT", "8000"),
            "--database-provider",
            "neo4j",
            "--llm-provider",
            "openai",
            "--model",
            settings.model,
            "--embedder-provider",
            "openai",
            "--embedder-model",
            settings.embedder_model,
            *extra_args,
        ]

    def environment(self, password: str, settings: ModelSettings) -> dict[str, str]:
        """Build the upstream process environment without a Graphiti config file."""
        environment = os.environ.copy()
        environment.setdefault("NEO4J_URI", "bolt://127.0.0.1:7687")
        environment.setdefault("NEO4J_USER", "neo4j")
        environment.setdefault("NEO4J_PASSWORD", password)
        environment.setdefault("NEO4J_DATABASE", "neo4j")
        environment.update(settings.graphiti_environment())
        return environment

    def connection_settings(
        self,
        password: str,
        settings: ModelSettings | None = None,
    ) -> dict[str, object]:
        """Return the resolved Neo4j, model, and proxy settings."""
        settings = settings or ModelSettings.resolve()
        environment = self.environment(password, settings)
        result: dict[str, object] = {
            name: environment[name]
            for name in ("NEO4J_URI", "NEO4J_USER", "NEO4J_PASSWORD", "NEO4J_DATABASE")
        }
        result.update(settings.public_settings())
        return result

    def _require_mise(self) -> None:
        if not shutil.which("mise"):
            raise RuntimeError("mise is required; install it from https://mise.jdx.dev")

    def _ensure_mise_tool(self, tool: str, version: str) -> None:
        result = subprocess.run(
            ["mise", "where", f"{tool}@{version}"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        if result.returncode:
            subprocess.run(["mise", "use", "-g", "--yes", f"{tool}@{version}"], check=True)

    def _install_neo4j(self) -> None:
        if (self.paths.neo4j / "bin" / "neo4j").exists():
            return
        archive = self.paths.root / f"neo4j-community-{NEO4J_VERSION}-unix.tar.gz"
        url = f"https://dist.neo4j.org/neo4j-community-{NEO4J_VERSION}-unix.tar.gz"
        _download(url, archive)
        target_parent = self.paths.neo4j.parent
        target_parent.mkdir(parents=True, exist_ok=True)
        with tarfile.open(archive, "r:gz") as bundle:
            _extract_archive(bundle, target_parent)
        extracted = target_parent / f"neo4j-community-{NEO4J_VERSION}"
        extracted.rename(self.paths.neo4j)
        archive.unlink()

    def _install_graphiti(self) -> None:
        if (self.paths.graphiti / "mcp_server" / "main.py").exists():
            return
        archive = self.paths.root / f"graphiti-{GRAPHITI_VERSION}.tar.gz"
        url = f"https://github.com/getzep/graphiti/archive/refs/tags/v{GRAPHITI_VERSION}.tar.gz"
        _download(url, archive)
        target_parent = self.paths.graphiti.parent
        target_parent.mkdir(parents=True, exist_ok=True)
        with tarfile.open(archive, "r:gz") as bundle:
            _extract_archive(bundle, target_parent)
        extracted = target_parent / f"graphiti-{GRAPHITI_VERSION}"
        extracted.rename(self.paths.graphiti)
        archive.unlink()
        subprocess.run(
            [
                "mise",
                "exec",
                f"uv@{UV_VERSION}",
                "--",
                "uv",
                "sync",
                "--project",
                str(self.paths.graphiti / "mcp_server"),
            ],
            check=True,
        )

    def _ensure_state(self) -> None:
        if self.paths.state.exists():
            return
        password = secrets.token_urlsafe(24)
        self._write_state({"neo4j_password": password})
        subprocess.run(
            self._mise_java_command(
                self.paths.neo4j / "bin" / "neo4j-admin",
                "dbms",
                "set-initial-password",
                password,
            ),
            env=self._neo4j_environment(),
            check=True,
        )

    def _start_neo4j(self, password: str) -> None:
        del password
        result = self._neo4j_command("status", check=False)
        if result.returncode:
            self._neo4j_command("start")
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            result = self._neo4j_command("status", check=False)
            if result.returncode == 0:
                return
            time.sleep(1)
        raise RuntimeError("Neo4j did not become ready within 60 seconds")

    def _start_litellm(
        self,
        settings: ModelSettings,
        state: dict[str, object],
    ) -> bool:
        if not settings.manage_litellm:
            return False
        if _url_ready(settings.health_url):
            return False
        existing_pid = state.get("litellm_pid")
        if isinstance(existing_pid, int) and _is_running(existing_pid):
            self._wait_for_litellm(settings, existing_pid)
            return False
        command = [
            sys.executable,
            "-m",
            "dbx_tools.litellm",
            "--host",
            settings.litellm_host,
            "--port",
            str(settings.litellm_port),
        ]
        environment = os.environ.copy()
        environment.update(settings.databricks_environment())
        with self.paths.litellm_log.open("ab") as output:
            process = subprocess.Popen(
                command,
                env=environment,
                stdout=output,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        state["litellm_pid"] = process.pid
        state["model_settings"] = settings.public_settings()
        self._write_state(state)
        try:
            self._wait_for_litellm(settings, process.pid)
        except Exception:
            self._stop_litellm(state)
            raise
        return True

    def _stop_litellm(self, state: dict[str, object]) -> None:
        _terminate_pid(state.pop("litellm_pid", None))
        if state:
            self._write_state(state)

    def _wait_for_litellm(self, settings: ModelSettings, pid: int) -> None:
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if _url_ready(settings.health_url):
                return
            if not _is_running(pid):
                raise RuntimeError(
                    f"LiteLLM exited before becoming ready; see {self.paths.litellm_log}"
                )
            time.sleep(1)
        raise RuntimeError(
            f"LiteLLM did not become ready within 60 seconds; see {self.paths.litellm_log}"
        )

    def _neo4j_command(
        self,
        action: str,
        *,
        check: bool = False,
        capture_output: bool = False,
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            self._mise_java_command(self.paths.neo4j / "bin" / "neo4j", action),
            env=self._neo4j_environment(),
            text=True,
            check=check,
            capture_output=capture_output,
        )

    def _mise_java_command(self, executable: Path, *arguments: str) -> list[str]:
        return ["mise", "exec", f"java@{JAVA_VERSION}", "--", str(executable), *arguments]

    def _neo4j_environment(self) -> dict[str, str]:
        environment = os.environ.copy()
        environment["NEO4J_HOME"] = str(self.paths.neo4j)
        environment["NEO4J_CONF"] = str(self.paths.neo4j / "conf")
        environment["NEO4J_server_directories_data"] = str(self.paths.neo4j_data)
        environment["NEO4J_server_default__listen__address"] = "127.0.0.1"
        return environment

    def read_state(self, *, required: bool = True) -> dict[str, object]:
        if not self.paths.state.exists():
            if required:
                raise RuntimeError("Graphiti is not set up; run `dbx-graphiti setup`")
            return {}
        return json.loads(self.paths.state.read_text())

    def _write_state(self, state: dict[str, object]) -> None:
        self.paths.root.mkdir(parents=True, exist_ok=True)
        self.paths.state.write_text(json.dumps(state, indent=2) + "\n")
        self.paths.state.chmod(0o600)


def _download(url: str, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(f"{target.suffix}.part")
    with urllib.request.urlopen(url) as response, temporary.open("wb") as output:
        shutil.copyfileobj(response, output)
    temporary.replace(target)


def _extract_archive(bundle: tarfile.TarFile, destination: Path) -> None:
    destination = destination.resolve()
    for member in bundle.getmembers():
        extracted = (destination / member.name).resolve()
        if destination not in extracted.parents and extracted != destination:
            raise RuntimeError(f"Archive member escapes destination: {member.name}")
    bundle.extractall(destination)


def _url_ready(url: str) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=1) as response:
            return response.status < 500
    except OSError:
        return False


def _terminate_pid(pid: object) -> None:
    if isinstance(pid, int) and _is_running(pid):
        os.kill(pid, signal.SIGTERM)


def _is_running(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True
