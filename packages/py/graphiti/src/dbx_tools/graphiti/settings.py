from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass

from dbx_tools.core import config

"""Model and gateway settings for the native Graphiti launcher."""

DEFAULT_MODEL_GATEWAY_HOST = "127.0.0.1"
DEFAULT_MODEL_GATEWAY_PORT = 4400
DEFAULT_MODEL = "databricks-gpt-5-nano"
DEFAULT_EMBEDDER_MODEL = "databricks-gte-large-en"
DEFAULT_EMBEDDER_DIMENSIONS = 1024
DEFAULT_STRUCTURED_OUTPUT_MODE = "json_object"


@dataclass(frozen=True)
class ModelSettings:
    """Resolved Graphiti model settings and model gateway ownership policy."""

    profile: str | None
    manage_model_gateway: bool
    model_gateway_host: str
    model_gateway_port: int
    model_gateway_command: str | None
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
        model_gateway_host: str | None = None,
        model_gateway_port: int | None = None,
        model_gateway_url: str | None = None,
        model_gateway_command: str | None = None,
        manage_model_gateway: bool | None = None,
        environ: Mapping[str, str] | None = None,
    ) -> ModelSettings:
        """Resolve CLI values over environment values and defaults."""
        env = os.environ if environ is None else environ
        options: config.ConfigOptions = {
            "scope": (),
            "sources": "config",
            "data": env,
        }
        resolved_host = (
            config.string(model_gateway_host, "MODEL_GATEWAY_HOST", options)
            or DEFAULT_MODEL_GATEWAY_HOST
        )
        resolved_port = config.positive_int(
            model_gateway_port,
            "MODEL_GATEWAY_PORT",
            DEFAULT_MODEL_GATEWAY_PORT,
            options,
        )
        configured_gateway_url = config.string(
            model_gateway_url,
            "MODEL_GATEWAY_URL",
            options,
        )
        configured_openai_url = config.string(None, "OPENAI_API_URL", options)
        configured_manage = config.boolean(
            manage_model_gateway,
            "MANAGE_MODEL_GATEWAY",
            options,
        )
        resolved_manage = (
            configured_manage
            if configured_manage is not None
            else configured_gateway_url is None and configured_openai_url is None
        )
        local_url = f"http://{resolved_host}:{resolved_port}/v1"
        openai_url = (
            local_url
            if resolved_manage
            else configured_gateway_url or configured_openai_url or local_url
        )
        gateway_mode = resolved_manage or configured_gateway_url is not None
        api_key = config.string(None, "OPENAI_API_KEY", options)
        if api_key is None:
            if gateway_mode:
                api_key = "not-required"
            else:
                raise ValueError(
                    "OPENAI_API_KEY is required when the managed model gateway is disabled "
                    "and OPENAI_API_URL points at an external provider"
                )
        dimensions = config.positive_int(
            embedder_dimensions,
            ("EMBEDDER_DIMENSIONS", "EMBEDDER__DIMENSIONS", "EMBEDDING_DIM"),
            DEFAULT_EMBEDDER_DIMENSIONS,
            options,
        )
        resolved_profile = profile.strip() if profile and profile.strip() else None
        return cls(
            profile=resolved_profile,
            manage_model_gateway=resolved_manage,
            model_gateway_host=resolved_host,
            model_gateway_port=resolved_port,
            model_gateway_command=config.string(
                model_gateway_command,
                "MODEL_GATEWAY_COMMAND",
                options,
            ),
            openai_api_url=openai_url.rstrip("/"),
            openai_api_key=api_key,
            model=config.string(model, "MODEL_NAME", options) or DEFAULT_MODEL,
            embedder_model=(
                config.string(embedder_model, "EMBEDDER_MODEL", options) or DEFAULT_EMBEDDER_MODEL
            ),
            embedder_dimensions=dimensions,
            structured_output_mode=(
                config.string(None, "LLM_STRUCTURED_OUTPUT_MODE", options)
                or DEFAULT_STRUCTURED_OUTPUT_MODE
            ),
        )

    @property
    def health_url(self) -> str:
        """Health endpoint for the configured OpenAI-compatible model gateway."""
        base = self.openai_api_url.removesuffix("/v1")
        return f"{base}/api/healthz"

    def graphiti_environment(self) -> dict[str, str]:
        """Non-secret settings injected into the upstream Graphiti process."""
        return {
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

    def public_settings(self) -> dict[str, object]:
        """Settings safe to include in status and environment output."""
        return {
            "profile": self.profile,
            "manage_model_gateway": self.manage_model_gateway,
            "model_gateway_url": self.openai_api_url,
            "model": self.model,
            "embedder_model": self.embedder_model,
            "embedder_dimensions": self.embedder_dimensions,
            "structured_output_mode": self.structured_output_mode,
        }
