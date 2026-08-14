from __future__ import annotations

import json
import os
import secrets
import shlex
import shutil
import signal
import subprocess
import sys
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from dbx_tools.core import bin
from honcho.manager import Manager

from .constants import PROCESS_STATE_PATH_ENV, UPSTREAM_MCP_PATH_ENV
from .settings import ModelSettings

"""Installation and native process lifecycle for Graphiti, LiteLLM, and Neo4j."""

GRAPHITI_VERSION = "0.29.3"
NEO4J_VERSION = "5.26.12"
JAVA_VERSION = "21"
UV_VERSION = "0.11"
SUPERVISOR_START_TIMEOUT = 5.0

GRAPHITI_MISE_TOOL = (
    "http:graphiti["
    "url=https://github.com/getzep/graphiti/archive/refs/tags/v{{version}}.tar.gz,"
    "strip_components=1"
    f"]@{GRAPHITI_VERSION}"
)
NEO4J_MISE_TOOL = f"neo4j@{NEO4J_VERSION}"
JAVA_MISE_TOOL = f"java@{JAVA_VERSION}"
UV_MISE_TOOL = f"uv@{UV_VERSION}"


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
        return self.root / "tools" / "graphiti" / GRAPHITI_VERSION

    @property
    def neo4j(self) -> Path:
        return self.root / "tools" / "neo4j" / NEO4J_VERSION

    @property
    def neo4j_data(self) -> Path:
        return self.root / "data" / "neo4j"

    @property
    def state(self) -> Path:
        return self.root / "state.json"

    @property
    def log(self) -> Path:
        return self.root / "graphiti.log"


class _GraphitiManager(Manager):
    """Honcho manager that reaps the recorded Graphiti process group first."""

    def __init__(self, runtime: Runtime) -> None:
        super().__init__()
        self._runtime = runtime

    def terminate(self) -> None:
        state = self._runtime.read_state(required=False)
        _terminate_process_group(state.get("graphiti_process_group"))
        super().terminate()


class Runtime:
    """Provision and run a pinned native Graphiti stack."""

    def __init__(self, paths: RuntimePaths | None = None) -> None:
        self.paths = paths or RuntimePaths.default()

    def _ensure_runtime(self) -> None:
        """Install and initialize runtime prerequisites on first start."""
        bin.ensure_tool(JAVA_MISE_TOOL)
        bin.resolve("uv", mise_tool=UV_MISE_TOOL)
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
        self._ensure_runtime()
        state = self.read_state()
        self._start_neo4j(state["neo4j_password"])
        if foreground:
            return self.supervise(settings, extra_args or [])
        command = [
            sys.executable,
            "-m",
            "dbx_tools.graphiti.supervisor",
            "--home",
            str(self.paths.root),
            "--",
            *(extra_args or []),
        ]
        try:
            with self.paths.log.open("ab") as output:
                process = subprocess.Popen(
                    command,
                    env=self._supervisor_environment(settings),
                    stdout=output,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                )
        except Exception:
            self._neo4j_command("stop", check=False)
            raise
        self._wait_for_supervisor(process.pid)
        return process.pid

    def stop(self) -> None:
        state = self.read_state(required=False)
        supervisor_pid = state.get("graphiti_pid")
        if isinstance(supervisor_pid, int) and _is_running(supervisor_pid):
            os.kill(supervisor_pid, signal.SIGTERM)
        _terminate_process_group(state.get("graphiti_process_group"))
        if (self.paths.neo4j / "bin" / "neo4j").exists():
            self._neo4j_command("stop", check=False)
        state = self.read_state(required=False)
        self._clear_process_state(state)

    def status(self) -> dict[str, object]:
        state = self.read_state(required=False)
        pid = state.get("graphiti_pid")
        model_settings = state.get("model_settings")
        manages_litellm = (
            model_settings.get("manage_litellm") if isinstance(model_settings, dict) else None
        )
        litellm_url = (
            model_settings.get("litellm_url") if isinstance(model_settings, dict) else None
        )
        litellm_running = isinstance(litellm_url, str) and _url_ready(
            f"{litellm_url.removesuffix('/v1')}/health/readiness"
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
            "mcp_url": f"http://{_graphiti_host()}:{_graphiti_port()}/mcp/",
            "litellm": (
                "running"
                if manages_litellm is True and litellm_running
                else "external"
                if manages_litellm is False
                else "stopped"
            ),
            "models": model_settings,
        }

    def graphiti_command(self, settings: ModelSettings, extra_args: list[str]) -> list[str]:
        """Build the upstream command entirely from defaults, environment, and CLI flags."""
        return [
            *self._uv_command(),
            "run",
            "--project",
            str(self.paths.graphiti / "mcp_server"),
            "python",
            "-m",
            "dbx_tools.graphiti.server",
            "--host",
            _graphiti_host(),
            "--port",
            _graphiti_port(),
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
        existing_python_path = environment.get("PYTHONPATH")
        environment["PYTHONPATH"] = os.pathsep.join(
            [
                *_child_python_paths(),
                *([existing_python_path] if existing_python_path else []),
            ]
        )
        environment[UPSTREAM_MCP_PATH_ENV] = str(self.paths.graphiti / "mcp_server")
        environment[PROCESS_STATE_PATH_ENV] = str(self.paths.state)
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

    def supervise(
        self,
        settings: ModelSettings,
        extra_args: list[str],
    ) -> int:
        """Run Graphiti and managed LiteLLM under Honcho."""
        state = self.read_state()
        manager = _GraphitiManager(self)
        state.update(
            {
                "graphiti_pid": os.getpid(),
                "graphiti_supervisor": True,
                "model_settings": settings.public_settings(),
            }
        )
        self._write_state(state)
        try:
            if settings.manage_litellm and not _url_ready(settings.health_url):
                manager.add_process(
                    "litellm",
                    shlex.join(self._litellm_command(settings)),
                    env=self._litellm_environment(settings),
                )
            manager.add_process(
                "graphiti",
                shlex.join(self.graphiti_command(settings, extra_args)),
                cwd=self.paths.graphiti / "mcp_server",
                env=self.environment(str(state["neo4j_password"]), settings),
            )
            manager.loop()
            return manager.returncode or 0
        finally:
            if (self.paths.neo4j / "bin" / "neo4j").exists():
                self._neo4j_command("stop", check=False)
            self._clear_process_state(self.read_state(required=False))

    def _supervisor_environment(self, settings: ModelSettings) -> dict[str, str]:
        environment = os.environ.copy()
        environment.update(settings.graphiti_environment())
        environment.update(
            {
                "MANAGE_LITELLM": "true" if settings.manage_litellm else "false",
                "LITELLM_HOST": settings.litellm_host,
                "LITELLM_PORT": str(settings.litellm_port),
                "LITELLM_URL": settings.openai_api_url,
            }
        )
        return environment

    def _wait_for_supervisor(self, pid: int) -> None:
        deadline = time.monotonic() + SUPERVISOR_START_TIMEOUT
        while time.monotonic() < deadline:
            state = self.read_state(required=False)
            if state.get("graphiti_pid") == pid and state.get("graphiti_supervisor") is True:
                return
            if not _is_running(pid):
                raise RuntimeError(
                    f"Graphiti supervisor exited during startup; see {self.paths.log}"
                )
            time.sleep(0.1)
        os.kill(pid, signal.SIGTERM)
        raise RuntimeError(
            f"Graphiti supervisor did not start within {SUPERVISOR_START_TIMEOUT:g} seconds; "
            f"see {self.paths.log}"
        )

    def _clear_process_state(self, state: dict[str, object]) -> None:
        for name in (
            "graphiti_child_pid",
            "graphiti_pid",
            "graphiti_process_group",
            "graphiti_supervisor",
            "litellm_pid",
        ):
            state.pop(name, None)
        if state:
            self._write_state(state)

    def _uv_command(self) -> list[str]:
        return [bin.resolve("uv", mise_tool=UV_MISE_TOOL)]

    def _install_neo4j(self) -> None:
        installation = bin.ensure_tool(NEO4J_MISE_TOOL)
        _link_tool(installation.root, self.paths.neo4j)

    def _install_graphiti(self) -> None:
        installation = bin.ensure_tool(GRAPHITI_MISE_TOOL)
        _link_tool(installation.root, self.paths.graphiti)
        subprocess.run(
            [
                *self._uv_command(),
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
        self._set_initial_password(password)

    def _set_initial_password(self, password: str) -> None:
        """Initialize the ephemeral Neo4j store with the launcher password."""
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
        result = self._neo4j_command("status", check=False)
        if result.returncode:
            self._neo4j_command("start")
        authenticated, authentication_failed = self._wait_for_neo4j(password)
        if authenticated:
            return
        if not authentication_failed or not _persistence_configured():
            raise RuntimeError("Neo4j did not become ready with the configured credentials")
        self._neo4j_command("stop", check=False)
        shutil.rmtree(self.paths.neo4j_data, ignore_errors=True)
        self._set_initial_password(password)
        self._neo4j_command("start")
        authenticated, _ = self._wait_for_neo4j(password)
        if authenticated:
            return
        raise RuntimeError("Neo4j did not recover after resetting its ephemeral data")

    def _wait_for_neo4j(self, password: str) -> tuple[bool, bool]:
        """Wait for Bolt readiness and distinguish authentication rejection."""
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            result = self._neo4j_command("status", check=False)
            if result.returncode == 0:
                authenticated = self._neo4j_auth_command(password)
                if authenticated.returncode == 0:
                    return True, False
                detail = f"{authenticated.stdout}\n{authenticated.stderr}".lower()
                if "authentication" in detail or "credentials" in detail:
                    return False, True
            time.sleep(1)
        return False, False

    def _neo4j_auth_command(self, password: str) -> subprocess.CompletedProcess[str]:
        """Probe Neo4j with the launcher credential without logging the secret."""
        return subprocess.run(
            self._mise_java_command(
                self.paths.neo4j / "bin" / "cypher-shell",
                "--address",
                os.getenv("NEO4J_URI", "bolt://127.0.0.1:7687"),
                "--username",
                os.getenv("NEO4J_USER", "neo4j"),
                "--password",
                password,
                "RETURN 1",
            ),
            env=self._neo4j_environment(),
            text=True,
            check=False,
            capture_output=True,
        )

    def _litellm_command(self, settings: ModelSettings) -> list[str]:
        return [
            sys.executable,
            "-m",
            "dbx_tools.litellm",
            "--host",
            settings.litellm_host,
            "--port",
            str(settings.litellm_port),
        ]

    def _litellm_environment(self, settings: ModelSettings) -> dict[str, str]:
        environment = os.environ.copy()
        environment.update(settings.databricks_environment())
        return environment

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
        mise = bin.ensure_tool(JAVA_MISE_TOOL).mise
        return [str(mise), "exec", JAVA_MISE_TOOL, "--", str(executable), *arguments]

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
                raise RuntimeError("Graphiti has not been started")
            return {}
        return json.loads(self.paths.state.read_text())

    def _write_state(self, state: dict[str, object]) -> None:
        self.paths.root.mkdir(parents=True, exist_ok=True)
        self.paths.state.write_text(json.dumps(state, indent=2) + "\n")
        self.paths.state.chmod(0o600)


def _link_tool(source: Path, destination: Path) -> None:
    """Link one mise-managed installation into the launcher runtime layout."""
    source = source.expanduser().absolute()
    if destination.is_symlink():
        current = destination.readlink()
        current = current if current.is_absolute() else destination.parent / current
        if current.absolute() == source:
            return
        destination.unlink()
    elif destination.exists():
        raise RuntimeError(f"Tool destination exists outside mise: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        destination.symlink_to(source, target_is_directory=True)
    except FileExistsError:
        if not destination.is_symlink() or destination.readlink() != source:
            raise


def _url_ready(url: str) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=1) as response:
            return response.status < 500
    except OSError:
        return False


def _graphiti_host() -> str:
    """Resolve the listener host for local or Databricks App execution."""
    return os.getenv(
        "GRAPHITI_HOST", "0.0.0.0" if os.getenv("DATABRICKS_APP_PORT") else "127.0.0.1"
    )


def _graphiti_port() -> str:
    """Resolve the listener port, honoring Databricks App injection."""
    return os.getenv("GRAPHITI_PORT") or os.getenv("DATABRICKS_APP_PORT", "8000")


def _child_python_paths() -> list[str]:
    """Expose this package and its dependencies to the upstream virtualenv."""
    paths = [str(Path(__file__).resolve().parents[2])]
    for value in sys.path:
        if not value:
            continue
        resolved = str(Path(value).resolve())
        if resolved not in paths:
            paths.append(resolved)
    return paths


def _persistence_configured() -> bool:
    """Return whether Postgres can rebuild an ephemeral Neo4j store."""
    return any(
        os.getenv(name)
        for name in (
            "JOURNAL_DATABASE_URL",
            "LAKEBASE_ENDPOINT",
            "LAKEBASE_INSTANCE_NAME",
            "PGHOST",
        )
    )


def _terminate_process_group(process_group: object) -> None:
    """Terminate a recorded sidecar group, escalating after Honcho's grace."""
    if not isinstance(process_group, int) or not _is_process_group_running(process_group):
        return
    os.killpg(process_group, signal.SIGTERM)
    deadline = time.monotonic() + 6
    while time.monotonic() < deadline:
        if not _is_process_group_running(process_group):
            return
        time.sleep(0.1)
    if _is_process_group_running(process_group):
        os.killpg(process_group, signal.SIGKILL)


def _is_process_group_running(process_group: int) -> bool:
    """Return whether a POSIX process group still has members."""
    try:
        os.killpg(process_group, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _is_running(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True
