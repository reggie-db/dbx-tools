"""Live Databricks model catalogue and fuzzy resolution for LiteLLM."""

from __future__ import annotations

import json
import os
import subprocess
from collections.abc import Mapping
from threading import RLock

from dbx_tools.model import (
    DEFAULT_FUZZY_THRESHOLD,
    ReasoningEffort,
    ServingEndpointSummary,
    endpoint_capabilities,
    list_serving_endpoints,
    rank_model_id,
    reasoning_efforts_by_family,
)

from .credentials import Credentials, DatabricksCredentials
from .models import register_streaming_support

DATABRICKS_PROFILE_ENV = "DATABRICKS_CONFIG_PROFILE"


def require_profile(
    profile: str | None = None,
    *,
    environ: Mapping[str, str] | None = None,
) -> str:
    """Resolve the CLI argument, configured environment, or Databricks CLI default."""
    env = os.environ if environ is None else environ
    selected = _profile_name(profile) or _profile_name(env.get(DATABRICKS_PROFILE_ENV))
    return selected or _default_cli_profile()


def _default_cli_profile() -> str:
    try:
        result = subprocess.run(
            ["databricks", "auth", "profiles", "-o", "json", "--skip-validate"],
            check=True,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError as error:
        raise RuntimeError(
            "No Databricks profile was selected and the databricks CLI is not installed"
        ) from error
    except subprocess.CalledProcessError as error:
        detail = (error.stderr or "").strip()
        suffix = f": {detail}" if detail else ""
        raise RuntimeError(f"Could not read the Databricks CLI default profile{suffix}") from error

    try:
        payload = json.loads(result.stdout)
    except (TypeError, json.JSONDecodeError) as error:
        raise RuntimeError("Databricks CLI returned invalid profile JSON") from error
    profiles = payload.get("profiles") if isinstance(payload, dict) else None
    defaults = [
        name
        for item in profiles or []
        if isinstance(item, dict)
        and item.get("default") is True
        and (name := _profile_name(item.get("name"))) is not None
    ]
    if len(defaults) != 1:
        raise RuntimeError(
            "No Databricks profile was selected and the CLI has no configured default profile"
        )
    return defaults[0]


def _profile_name(value: object) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


class DatabricksLiteLLMBackend:
    """Own one profile-scoped SDK client and its lazily refreshed model list."""

    def __init__(
        self,
        *,
        profile: str | None = None,
        threshold: float = DEFAULT_FUZZY_THRESHOLD,
    ) -> None:
        self.profile = require_profile(profile)
        self.threshold = threshold

        # LiteLLM's built-in Databricks provider constructs WorkspaceClient()
        # itself. Pin its unified-auth lookup to the same resolved profile used
        # by this resolver, for any path that still falls back to SDK auth.
        os.environ[DATABRICKS_PROFILE_ENV] = self.profile

        self._credentials = DatabricksCredentials(profile=self.profile)
        self.client = self._credentials.client
        self._models: list[ServingEndpointSummary] | None = None
        self._lock = RLock()

    def credentials(self) -> Credentials:
        """Return the cached bearer token and serving base URL for this profile."""
        return self._credentials.current()

    def models(self, *, force: bool = False) -> list[ServingEndpointSummary]:
        """List once per process, with an explicit refresh path for misses."""
        with self._lock:
            if self._models is None or force:
                self._models = list_serving_endpoints(self.client)
            return list(self._models)

    def resolve(self, requested: str, *, requires_tools: bool = False) -> str:
        """Resolve a loose model name, refreshing the live catalogue on a miss."""
        query = _strip_provider_prefix(requested)
        resolved = rank_model_id(
            self.models(),
            query,
            threshold=self.threshold,
            requires_tools=requires_tools,
        )
        if not resolved.matched:
            resolved = rank_model_id(
                self.models(force=True),
                query,
                threshold=self.threshold,
                requires_tools=requires_tools,
            )

        model_id = resolved.model_id
        if requires_tools:
            endpoint = next(
                (candidate for candidate in self.models() if candidate.name == model_id),
                None,
            )
            if endpoint is None or not endpoint_capabilities(endpoint).tools:
                raise ValueError(f'Model "{model_id}" does not support function tools')
        register_streaming_support(model_id)
        return model_id

    def reasoning_efforts(self, model_id: str) -> tuple[ReasoningEffort, ...]:
        """Return Databricks-derived effort levels, with family fallback."""
        endpoint = next(
            (candidate for candidate in self.models() if candidate.name == model_id), None
        )
        if endpoint is not None and endpoint.reasoning_efforts:
            return endpoint.reasoning_efforts
        return reasoning_efforts_by_family(model_id)


def _strip_provider_prefix(model: str) -> str:
    for prefix in ("dbx/", "databricks/"):
        if model.startswith(prefix):
            return model[len(prefix) :]
    return model
