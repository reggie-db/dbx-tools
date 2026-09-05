"""Live Databricks model catalogue and fuzzy resolution for LiteLLM."""

from __future__ import annotations

import json
import os
import subprocess
from collections.abc import Mapping
from dataclasses import dataclass

from cachetools import TTLCache, cachedmethod
from dbx_tools.model import (
    DEFAULT_FUZZY_THRESHOLD,
    ReasoningEffort,
    ServingEndpointSummary,
    endpoint_capabilities,
    list_serving_endpoints,
    rank_model_id,
    reasoning_efforts_by_family,
)
from dbx_tools.model.models import model_search_query

from .credentials import Credentials, DatabricksCredentials
from .models import register_streaming_support

DATABRICKS_PROFILE_ENV = "DATABRICKS_CONFIG_PROFILE"
DEFAULT_MODEL_CACHE_TTL_SECONDS = 5 * 60


@dataclass(frozen=True)
class ModelCatalogue:
    """One endpoint snapshot."""

    endpoints: tuple[ServingEndpointSummary, ...]


def require_profile(
    profile: str | None = None,
    *,
    environ: Mapping[str, str] | None = None,
) -> str | None:
    """Resolve a profile, or ambient Databricks App authentication."""
    env = os.environ if environ is None else environ
    selected = _profile_name(profile) or _profile_name(env.get(DATABRICKS_PROFILE_ENV))
    if selected:
        return selected
    if _profile_name(env.get("DATABRICKS_HOST")):
        return None
    return _default_cli_profile()


def _default_cli_profile() -> str:
    try:
        result = subprocess.run(
            [
                "databricks",
                "auth",
                "profiles",
                "--output",
                "json",
                "--skip-validate",
            ],
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
    raw_profiles = payload.get("profiles") if isinstance(payload, dict) else None
    profiles = [
        (name, item.get("default") is True)
        for item in raw_profiles or []
        if isinstance(item, dict) and (name := _profile_name(item.get("name"))) is not None
    ]
    marked_default = next((name for name, default in profiles if default), None)
    if marked_default is not None:
        return marked_default
    if any(name == "DEFAULT" for name, _ in profiles):
        return "DEFAULT"
    if len(profiles) == 1:
        return profiles[0][0]
    raise RuntimeError(
        "No Databricks profile was selected and the CLI has no marked default, "
        "DEFAULT profile, or single configured profile"
    )


def _profile_name(value: object) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


class DatabricksLiteLLMBackend:
    """Own one profile-scoped SDK client and its lazily refreshed model list."""

    def __init__(
        self,
        *,
        profile: str | None = None,
        threshold: float = DEFAULT_FUZZY_THRESHOLD,
        cache_ttl_seconds: float = DEFAULT_MODEL_CACHE_TTL_SECONDS,
    ) -> None:
        if cache_ttl_seconds <= 0:
            raise ValueError("cache_ttl_seconds must be positive")
        self.profile = require_profile(profile)
        self.threshold = threshold
        self.cache_ttl_seconds = cache_ttl_seconds

        # Pin any LiteLLM SDK fallback to the same profile resolved for Rust
        # authentication and endpoint discovery.
        if self.profile:
            os.environ[DATABRICKS_PROFILE_ENV] = self.profile

        self._credentials = DatabricksCredentials(profile=self.profile)
        self._catalogue_cache: TTLCache[tuple[object, ...], ModelCatalogue] = TTLCache(
            maxsize=1,
            ttl=self.cache_ttl_seconds,
        )

    def credentials(self) -> Credentials:
        """Return the cached bearer token and serving base URL for this profile."""
        return self._credentials.current()

    def refresh_credentials(self, stale: Credentials) -> Credentials:
        """Ask Rust to refresh ``stale`` unless another caller advanced it."""
        return self._credentials.refresh(stale)

    @cachedmethod(lambda self: self._catalogue_cache)
    def catalogue(self) -> ModelCatalogue:
        """Return one TTL-cached endpoint snapshot."""
        endpoints = tuple(
            list_serving_endpoints(self._credentials.client(), include_deprecated=True)
        )
        return ModelCatalogue(endpoints=endpoints)

    def refresh_catalogue(self) -> ModelCatalogue:
        """Invalidate the endpoint snapshot and load it again."""
        self._catalogue_cache.clear()
        return self.catalogue()

    def models(self, *, force: bool = False) -> list[ServingEndpointSummary]:
        """Return lazily discovered endpoints from the TTL-cached catalogue."""
        catalogue = self.refresh_catalogue() if force else self.catalogue()
        return list(catalogue.endpoints)

    def resolve(self, requested: str, *, requires_tools: bool = False) -> str:
        """Resolve a loose model name, refreshing the live catalogue on a miss."""
        catalogue = self.catalogue()
        models = list(catalogue.endpoints)
        query = _resolution_query(requested, models)
        resolved = rank_model_id(
            models,
            query,
            threshold=self.threshold,
            requires_tools=requires_tools,
        )
        if not resolved.matched:
            catalogue = self.refresh_catalogue()
            models = list(catalogue.endpoints)
            query = _resolution_query(requested, models)
            resolved = rank_model_id(
                models,
                query,
                threshold=self.threshold,
                requires_tools=requires_tools,
            )

        model_id = resolved.model_id
        if requires_tools:
            endpoint = next(
                (candidate for candidate in models if candidate.name == model_id),
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


def _resolution_query(
    requested: str,
    models: list[ServingEndpointSummary],
) -> str:
    stripped = requested.strip()
    if any(endpoint.name == stripped for endpoint in models):
        return stripped
    return model_search_query(stripped) or stripped
