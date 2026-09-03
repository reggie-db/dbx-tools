from __future__ import annotations

import re
from collections.abc import Iterable

from .models import ModelFamily, ReasoningEffort, parse_model_name

STANDARD_REASONING_EFFORTS = (
    ReasoningEffort.LOW,
    ReasoningEffort.MEDIUM,
    ReasoningEffort.HIGH,
)
GPT_5_6_REASONING_EFFORTS = (
    ReasoningEffort.NONE,
    *STANDARD_REASONING_EFFORTS,
    ReasoningEffort.XHIGH,
    ReasoningEffort.MAX,
)
_GPT_5_5_PRO_REASONING_EFFORTS = (
    ReasoningEffort.MEDIUM,
    ReasoningEffort.HIGH,
    ReasoningEffort.XHIGH,
)
_CLAUDE_REASONING_EFFORTS = (
    ReasoningEffort.NONE,
    ReasoningEffort.MINIMAL,
    *STANDARD_REASONING_EFFORTS,
    ReasoningEffort.XHIGH,
    ReasoningEffort.MAX,
)
_GEMINI_REASONING_EFFORTS = (
    ReasoningEffort.MINIMAL,
    *STANDARD_REASONING_EFFORTS,
)

_O_SERIES = re.compile(r"(?:^|[-_./])o(?:1|3|4)(?:[-_./]|$)", flags=re.IGNORECASE)


def reasoning_efforts_by_family(name: str) -> tuple[ReasoningEffort, ...]:
    """Infer accepted reasoning-effort levels from a model or served-entity name."""
    normalized = name.lower()
    parsed = parse_model_name(name)
    if parsed is not None and parsed.family == ModelFamily.GPT and parsed.version:
        gpt_version = (*parsed.version, 0)[:2]
        if gpt_version >= (5, 0):
            if gpt_version == (5, 5) and "pro" in parsed.model:
                return _GPT_5_5_PRO_REASONING_EFFORTS
            return (
                GPT_5_6_REASONING_EFFORTS if gpt_version == (5, 6) else STANDARD_REASONING_EFFORTS
            )
    if (
        parsed is not None and parsed.family == ModelFamily.GPT and "oss" in parsed.model
    ) or "codex" in normalized:
        return STANDARD_REASONING_EFFORTS
    if _O_SERIES.search(normalized):
        return STANDARD_REASONING_EFFORTS

    if (
        parsed is not None
        and parsed.family == ModelFamily.CLAUDE
        and (*parsed.version, 0)[:2] >= (3, 7)
    ):
        return _CLAUDE_REASONING_EFFORTS
    if parsed is not None and parsed.family == ModelFamily.GEMINI:
        return _GEMINI_REASONING_EFFORTS
    return ()


def reasoning_efforts_for_names(names: Iterable[str]) -> tuple[ReasoningEffort, ...]:
    """Return the richest inferred effort list across endpoint and entity identities."""
    inferred = (reasoning_efforts_by_family(name) for name in names)
    return max(inferred, key=len, default=())


reasoningEffortsByFamily = reasoning_efforts_by_family
reasoningEffortsForNames = reasoning_efforts_for_names
