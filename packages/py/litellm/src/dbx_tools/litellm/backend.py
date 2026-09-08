"""Live Databricks model catalogue and fuzzy resolution for LiteLLM."""

from __future__ import annotations

from dataclasses import dataclass
from threading import RLock

from cachetools import TTLCache, cachedmethod
from dbx_tools.model import (
    DEFAULT_FUZZY_THRESHOLD,
    ModelClass,
    ReasoningEffort,
    ServingEndpointSummary,
    endpoint_capabilities,
    list_serving_endpoints,
    rank_model_id,
    resolve_model,
)
from dbx_tools.model.models import ModelFamily, model_search_query, parse_model_name

from .credentials import Credentials, DatabricksCredentials

DEFAULT_MODEL_CACHE_TTL_SECONDS = 5 * 60
_NON_CODEX_MODEL_FAMILIES = frozenset(
    {
        ModelFamily.BGE,
        ModelFamily.CLAUDE,
        ModelFamily.GEMINI,
        ModelFamily.GTE,
        ModelFamily.INKLING,
    }
)
_backend: DatabricksLiteLLMBackend | None = None
_backend_lock = RLock()


@dataclass(frozen=True)
class ModelCatalogue:
    """One endpoint snapshot."""

    endpoints: tuple[ServingEndpointSummary, ...]


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
        self.threshold = threshold
        self.cache_ttl_seconds = cache_ttl_seconds
        self._credentials = DatabricksCredentials(profile=profile)
        self.profile = self._credentials.profile
        self._catalogue_cache: TTLCache[tuple[object, ...], ModelCatalogue] = TTLCache(
            maxsize=1,
            ttl=self.cache_ttl_seconds,
        )

    def credentials(self) -> Credentials:
        """Return the cached bearer token and inference URLs for this profile."""
        return self._credentials.current()

    def reasoning_efforts(self, model_id: str) -> tuple[ReasoningEffort, ...]:
        """Return cached reasoning metadata for an endpoint or model service."""
        endpoint = next(
            (
                endpoint
                for endpoint in self.models()
                if endpoint.name == model_id or gateway_model_name(endpoint.name) == model_id
            ),
            None,
        )
        return endpoint.reasoning_efforts if endpoint is not None else ()

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

    def resolve(
        self,
        requested: str,
        *,
        requires_tools: bool = False,
        model_class: ModelClass | None = None,
    ) -> str:
        """Resolve a loose model name, refreshing the live catalogue on a miss."""
        catalogue = self.catalogue()
        models = list(catalogue.endpoints)
        query = _resolution_query(requested, models)
        resolved = rank_model_id(
            models,
            query,
            threshold=self.threshold,
            requires_tools=requires_tools,
            model_class=model_class,
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
                model_class=model_class,
            )

        model_id = resolved.model_id
        if not resolved.matched and model_class is not None:
            selection = resolve_model(
                models,
                model_class=model_class,
                requires_tools=requires_tools,
            )
            model_id = selection.model_id
        if requires_tools:
            endpoint = next(
                (candidate for candidate in models if candidate.name == model_id),
                None,
            )
            if endpoint is None or not endpoint_capabilities(endpoint).tools:
                raise ValueError(f'Model "{model_id}" does not support function tools')
        return model_id


def get_backend(profile: str | None = None) -> DatabricksLiteLLMBackend:
    """Return the process-wide Databricks backend, optionally selecting its profile."""
    global _backend
    with _backend_lock:
        if _backend is None:
            _backend = DatabricksLiteLLMBackend(profile=profile)
        elif profile is not None and _backend.profile != profile:
            raise RuntimeError(
                f'LiteLLM already initialized profile "{_backend.profile}", not "{profile}"'
            )
        return _backend


def gateway_model_name(model_id: str) -> str | None:
    """Return the Unity Catalog model-service name for a foundation endpoint."""
    normalized = model_id.removeprefix("dbx/").removeprefix("databricks/")
    if normalized.startswith("system.ai."):
        return normalized
    if normalized.startswith("databricks-"):
        return f"system.ai.{normalized.removeprefix('databricks-')}"
    return None


def codex_gateway_model_name(model_id: str) -> str | None:
    """Return a model service supported by the Codex Responses gateway."""
    gateway_model = gateway_model_name(model_id)
    if gateway_model is None:
        return None
    parsed = parse_model_name(gateway_model)
    if parsed is None or "embedding" in parsed.model:
        return None
    return gateway_model if parsed.family not in _NON_CODEX_MODEL_FAMILIES else None


def _resolution_query(
    requested: str,
    models: list[ServingEndpointSummary],
) -> str:
    stripped = requested.strip()
    if any(endpoint.name == stripped for endpoint in models):
        return stripped
    return model_search_query(stripped) or stripped
