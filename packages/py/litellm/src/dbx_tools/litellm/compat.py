"""Narrow compatibility patches for LiteLLM defects exercised by the proxy."""

from __future__ import annotations

from typing import Any


def install_litellm_compatibility() -> None:
    from litellm.llms.base_llm.chat.transformation import BaseConfig

    original = BaseConfig.update_optional_params_with_thinking_tokens
    if getattr(original, "_dbx_tools_safe_reasoning", False):
        return

    def update_optional_params_with_thinking_tokens(
        self: BaseConfig,
        non_default_params: dict[str, Any],
        optional_params: dict[str, Any],
    ) -> None:
        if self.is_thinking_enabled(optional_params) and "thinking" not in optional_params:
            return
        original(self, non_default_params, optional_params)

    update_optional_params_with_thinking_tokens._dbx_tools_safe_reasoning = True  # type: ignore[attr-defined]
    BaseConfig.update_optional_params_with_thinking_tokens = (
        update_optional_params_with_thinking_tokens
    )
