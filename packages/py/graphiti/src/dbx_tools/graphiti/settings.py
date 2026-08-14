from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass

from dbx_tools.litellm.backend import DATABRICKS_PROFILE_ENV, require_profile

"""Model and proxy settings for the native Graphiti launcher."""

DEFAULT_LITELLM_HOST = "127.0.0.1"
DEFAULT_LITELLM_PORT = 4000
DEFAULT_MODEL = "dbx/databricks-gpt-5-nano"
DEFAULT_EMBEDDER_MODEL = "dbx/databricks-gte-large-en"
DEFAULT_EMBEDDER_DIMENSIONS = 1024
DEFAULT_STRUCTURED_OUTPUT_MODE = "json_object"


@dataclass(frozen=True)
class ModelSettings:
    """Resolved Graphiti model settings and LiteLLM ownership policy."""

    profile: str | None
    manage_litellm: bool
    litellm_host: str
    litellm_port: int
    openai_api_url: str
    openai_api_key: str
    model: str
    embedder_model: str
    embedder_dimensions: int
    structured_output_mode: str

    @classmethod
    def resolve(
        cls,
        *,
        profile: str | None = None,
        model: str | None = None,
        embedder_model: str | None = None,
        embedder_dimensions: int | None = None,
        litellm_host: str | None = None,
        litellm_port: int | None = None,
        litellm_url: str | None = None,
        manage_litellm: bool | None = None,
        environ: Mapping[str, str] | None = None,
    ) -> ModelSettings:
        """Resolve CLI values over environment values and defaults."""
        env = os.environ if environ is None else environ
        resolved_host = (
            _text(litellm_host) or _text(env.get("LITELLM_HOST")) or DEFAULT_LITELLM_HOST
        )
        resolved_port = _positive_int(
            litellm_port if litellm_port is not None else env.get("LITELLM_PORT"),
            DEFAULT_LITELLM_PORT,
            "LITELLM_PORT",
        )
        configured_proxy_url = _text(litellm_url) or _text(env.get("LITELLM_URL"))
        configured_openai_url = _text(env.get("OPENAI_API_URL"))
        configured_manage = (
            manage_litellm if manage_litellm is not None else _boolean(env.get("MANAGE_LITELLM"))
        )
        resolved_manage = (
            configured_manage
            if configured_manage is not None
            else configured_proxy_url is None and configured_openai_url is None
        )
        local_url = f"http://{resolved_host}:{resolved_port}/v1"
        openai_url = (
            local_url
            if resolved_manage
            else configured_proxy_url or configured_openai_url or local_url
        )
        proxy_mode = resolved_manage or configured_proxy_url is not None
        api_key = _text(env.get("OPENAI_API_KEY"))
        if api_key is None:
            if proxy_mode:
                api_key = "not-required"
            else:
                raise ValueError(
                    "OPENAI_API_KEY is required when managed LiteLLM is disabled "
                    "and OPENAI_API_URL points at an external provider"
                )
        dimensions = _positive_int(
            embedder_dimensions
            if embedder_dimensions is not None
            else env.get("EMBEDDER_DIMENSIONS")
            or env.get("EMBEDDER__DIMENSIONS")
            or env.get("EMBEDDING_DIM"),
            DEFAULT_EMBEDDER_DIMENSIONS,
            "EMBEDDER_DIMENSIONS",
        )
        resolved_profile = (
            require_profile(profile, environ=env)
            if resolved_manage
            else _text(profile) or _text(env.get(DATABRICKS_PROFILE_ENV))
        )
        return cls(
            profile=resolved_profile,
            manage_litellm=resolved_manage,
            litellm_host=resolved_host,
            litellm_port=resolved_port,
            openai_api_url=openai_url.rstrip("/"),
            openai_api_key=api_key,
            model=_text(model) or _text(env.get("MODEL_NAME")) or DEFAULT_MODEL,
            embedder_model=(
                _text(embedder_model) or _text(env.get("EMBEDDER_MODEL")) or DEFAULT_EMBEDDER_MODEL
            ),
            embedder_dimensions=dimensions,
            structured_output_mode=(
                _text(env.get("LLM_STRUCTURED_OUTPUT_MODE")) or DEFAULT_STRUCTURED_OUTPUT_MODE
            ),
        )

    @property
    def health_url(self) -> str:
        """LiteLLM readiness endpoint for the configured OpenAI-compatible URL."""
        base = self.openai_api_url.removesuffix("/v1")
        return f"{base}/health/readiness"

    def graphiti_environment(self) -> dict[str, str]:
        """Non-secret settings injected into the upstream Graphiti process."""
        return {
            **self.databricks_environment(),
            "OPENAI_API_URL": self.openai_api_url,
            "OPENAI_API_KEY": self.openai_api_key,
            "LLM__PROVIDERS__OPENAI__API_URL": self.openai_api_url,
            "LLM__PROVIDERS__OPENAI__API_KEY": self.openai_api_key,
            "MODEL_NAME": self.model,
            "EMBEDDER_MODEL": self.embedder_model,
            "EMBEDDER__PROVIDERS__OPENAI__API_URL": self.openai_api_url,
            "EMBEDDER__PROVIDERS__OPENAI__API_KEY": self.openai_api_key,
            "EMBEDDER_DIMENSIONS": str(self.embedder_dimensions),
            "EMBEDDER__DIMENSIONS": str(self.embedder_dimensions),
            "EMBEDDING_DIM": str(self.embedder_dimensions),
            "LLM_STRUCTURED_OUTPUT_MODE": self.structured_output_mode,
        }

    def databricks_environment(self) -> dict[str, str]:
        """Resolved profile environment shared by managed child processes."""
        if self.profile:
            return {DATABRICKS_PROFILE_ENV: self.profile}
        return {}

    def public_settings(self) -> dict[str, object]:
        """Settings safe to include in status and environment output."""
        return {
            "profile": self.profile,
            "manage_litellm": self.manage_litellm,
            "litellm_url": self.openai_api_url,
            "model": self.model,
            "embedder_model": self.embedder_model,
            "embedder_dimensions": self.embedder_dimensions,
            "structured_output_mode": self.structured_output_mode,
        }


def _text(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped or None


def _boolean(value: object) -> bool | None:
    if isinstance(value, bool):
        return value
    normalized = _text(value)
    if normalized is None:
        return None
    lowered = normalized.lower()
    if lowered in {"1", "true", "yes", "on"}:
        return True
    if lowered in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"MANAGE_LITELLM must be a boolean, got {value!r}")


def _positive_int(value: object, default: int, name: str) -> int:
    if value is None:
        return default
    try:
        parsed = int(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{name} must be a positive integer") from error
    if parsed <= 0:
        raise ValueError(f"{name} must be a positive integer")
    return parsed
