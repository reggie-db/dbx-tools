"""Model routing policy specific to the LiteLLM integration."""

from __future__ import annotations

import re

from dbx_tools.model import is_responses_only


def requires_responses_api(model: str) -> bool:
    """Return whether a Databricks endpoint rejects Chat Completions."""
    tokens = set(re.findall(r"[a-z0-9]+", model.lower()))
    return is_responses_only(model) or {"gpt", "pro"}.issubset(tokens)
