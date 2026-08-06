"""Live Databricks model catalogue and fuzzy resolution for LiteLLM."""

from __future__ import annotations

import os
from threading import RLock

from dbx_tools.model import (
    DEFAULT_FUZZY_THRESHOLD,
    ServingEndpointSummary,
    endpoint_capabilities,
    list_serving_endpoints,
    rank_model_id,
)

from .credentials import Credentials, DatabricksCredentials
from .models import register_streaming_support

PROFILE_ENV = "DBX_LITELLM_PROFILE"
DATABRICKS_PROFILE_ENV = "DATABRICKS_CONFIG_PROFILE"


def require_profile(profile: str | None = None) -> str:
    """Return an explicitly selected profile; never fall back to SDK defaults."""
    selected = profile or os.getenv(PROFILE_ENV) or os.getenv(DATABRICKS_PROFILE_ENV)
    if not selected:
        raise RuntimeError(
            "A Databricks profile is required. Pass --profile <name> or set "
            f"{PROFILE_ENV} or {DATABRICKS_PROFILE_ENV}."
        )
    return selected


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

        configured = os.getenv(DATABRICKS_PROFILE_ENV)
        if configured and configured != self.profile:
            raise RuntimeError(
                f"{DATABRICKS_PROFILE_ENV} selects {configured!r}, but the provider was "
                f"configured for {self.profile!r}."
            )
        # LiteLLM's built-in Databricks provider constructs WorkspaceClient()
        # itself. Pin its unified-auth lookup to the same explicit profile used
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


def _strip_provider_prefix(model: str) -> str:
    for prefix in ("dbx/", "databricks/"):
        if model.startswith(prefix):
            return model[len(prefix) :]
    return model
