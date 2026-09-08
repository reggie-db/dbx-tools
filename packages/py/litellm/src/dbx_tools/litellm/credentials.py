from __future__ import annotations

import asyncio
import threading
from collections.abc import Coroutine
from dataclasses import dataclass
from typing import Any, TypeVar

from databricks.sdk import WorkspaceClient
from dbx_tools.databricks import (
    DatabricksAuthOptions,
    PersistentAuth,
    create_persistent_auth,
)

"""Databricks credentials backed by the Rust authentication package."""

CODEX_API_PATH = "/ai-gateway/codex/v1"
MLFLOW_API_PATH = "/ai-gateway/mlflow/v1"
_T = TypeVar("_T")


@dataclass(frozen=True)
class Credentials:
    """A bearer token and the Databricks inference URLs it authenticates."""

    token: str
    api_base: str
    codex_api_base: str
    mlflow_api_base: str


class _AsyncBridge:
    """Run generated async binding calls from LiteLLM's synchronous hooks."""

    def __init__(self) -> None:
        self._ready = threading.Event()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        self._ready.wait()

    def run(self, coroutine: Coroutine[Any, Any, _T]) -> _T:
        """Block until one binding coroutine completes on the owned loop."""
        if self._loop is None:
            raise RuntimeError("Databricks auth event loop did not start")
        return asyncio.run_coroutine_threadsafe(coroutine, self._loop).result()

    def _run(self) -> None:
        """Own the event loop used by the generated UniFFI async surface."""
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        self._loop = loop
        self._ready.set()
        loop.run_forever()


class DatabricksCredentials:
    """Serve Rust-managed U2M or M2M credentials to LiteLLM and the SDK."""

    def __init__(self, *, profile: str | None) -> None:
        self._bridge = _AsyncBridge()
        self._auth: PersistentAuth = self._bridge.run(
            create_persistent_auth(
                DatabricksAuthOptions(
                    profile=profile,
                    prefer_user_to_machine=False,
                )
            )
        )
        status = self._auth.status()
        self.profile = status.profile
        self._host = status.host.rstrip("/")
        self._api_base = f"{self._host}/serving-endpoints"
        self._codex_api_base = f"{self._host}{CODEX_API_PATH}"
        self._mlflow_api_base = f"{self._host}{MLFLOW_API_PATH}"

    @property
    def api_base(self) -> str:
        """Return the Databricks Model Serving base URL."""
        return self._api_base

    def current(self) -> Credentials:
        """Return a token through Rust's persistent check-lock-check cache."""
        token = self._bridge.run(self._auth.token(False))
        return Credentials(
            token=token.access_token,
            api_base=self._api_base,
            codex_api_base=self._codex_api_base,
            mlflow_api_base=self._mlflow_api_base,
        )

    def client(self) -> WorkspaceClient:
        """Create an SDK client using the current Rust-managed bearer token."""
        return WorkspaceClient(host=self._host, token=self.current().token)
