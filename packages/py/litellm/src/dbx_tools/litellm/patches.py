"""Runtime hardening for upstream LiteLLM bugs the proxy has to survive.

Each patch here works around a concrete defect in the pinned LiteLLM release
(1.94.1) that our request shapes trigger. They are deliberately narrow and
idempotent, applied once at proxy startup by :func:`apply_litellm_patches`.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

_APPLIED = False


def apply_litellm_patches() -> None:
    """Apply every LiteLLM runtime patch exactly once."""
    global _APPLIED
    if _APPLIED:
        return
    _APPLIED = True
    _patch_thinking_tokens_keyerror()


def _patch_thinking_tokens_keyerror() -> None:
    """Stop `update_optional_params_with_thinking_tokens` raising KeyError.

    LiteLLM's `BaseConfig.is_thinking_enabled` returns True whenever
    `reasoning_effort` is present, but `DatabricksConfig.map_openai_params`
    only converts `reasoning_effort` into a `thinking` block for Claude models
    (`"claude" in model`). For every OTHER Databricks reasoning model
    (gpt-oss, gpt-5.x, ...), `reasoning_effort` stays set while `thinking` is
    never added, so the follow-up call to

        cast(dict, optional_params["thinking"]).get("budget_tokens", None)

    raises `KeyError: 'thinking'` — but only when the request omits
    `max_tokens`/`max_completion_tokens` (the Open WebUI case). Our auto-reasoning
    hook sends `reasoning_effort` to exactly these non-Claude models, so every
    such turn 500s with `APIConnectionError: 'thinking'`.

    The upstream method's whole job is to derive a `max_tokens` from a thinking
    token budget; with no `thinking` block there is no budget and nothing to do.
    We wrap it so a missing `thinking` key is a no-op instead of a crash, leaving
    the real (Claude) path untouched.
    """
    from litellm.llms.base_llm.chat.transformation import BaseConfig

    original = BaseConfig.update_optional_params_with_thinking_tokens

    def safe_update_optional_params_with_thinking_tokens(
        self: BaseConfig, non_default_params: dict, optional_params: dict
    ) -> Any:
        # Only the non-Claude path is buggy: `thinking` reported enabled (via
        # reasoning_effort) but no `thinking` block present. Treat that as
        # nothing-to-do, matching the method's contract when no budget exists.
        if self.is_thinking_enabled(optional_params) and "thinking" not in optional_params:
            return None
        return original(self, non_default_params, optional_params)

    BaseConfig.update_optional_params_with_thinking_tokens = (  # type: ignore[method-assign]
        safe_update_optional_params_with_thinking_tokens
    )
    logger.debug(
        "Patched BaseConfig.update_optional_params_with_thinking_tokens (thinking KeyError)"
    )
