from __future__ import annotations

import re
from collections.abc import Iterable

from .models import ReasoningEffort

STANDARD_REASONING_EFFORTS = (
    ReasoningEffort.LOW,
    ReasoningEffort.MEDIUM,
    ReasoningEffort.HIGH,
)
GPT_5_6_REASONING_EFFORTS = (*STANDARD_REASONING_EFFORTS, ReasoningEffort.XHIGH)
GPT_5_5_PRO_REASONING_EFFORTS = (
    ReasoningEffort.MEDIUM,
    ReasoningEffort.HIGH,
    ReasoningEffort.XHIGH,
)

_GPT_VERSION = re.compile(r"gpt[-_.](\d+)(?:[-_.](\d+))?", flags=re.IGNORECASE)
_CLAUDE_VERSION = re.compile(
    r"claude(?:[-_.][a-z]+)*[-_.](\d+)(?:[-_.](\d+))?",
    flags=re.IGNORECASE,
)
_O_SERIES = re.compile(r"(?:^|[-_./])o(?:1|3|4)(?:[-_./]|$)", flags=re.IGNORECASE)


def reasoning_efforts_by_family(name: str) -> tuple[ReasoningEffort, ...]:
    """Infer accepted reasoning-effort levels from a model or served-entity name."""
    normalized = name.lower()
    gpt_version = _version(_GPT_VERSION, normalized)
    if gpt_version is not None and gpt_version >= (5, 0):
        if gpt_version == (5, 5) and re.search(r"(?:^|[-_.])pro(?:[-_.]|$)", normalized):
            return GPT_5_5_PRO_REASONING_EFFORTS
        return GPT_5_6_REASONING_EFFORTS if gpt_version == (5, 6) else STANDARD_REASONING_EFFORTS
    if "gpt-oss" in normalized or "gpt_oss" in normalized or "codex" in normalized:
        return STANDARD_REASONING_EFFORTS
    if _O_SERIES.search(normalized):
        return STANDARD_REASONING_EFFORTS

    claude_version = _version(_CLAUDE_VERSION, normalized)
    if claude_version is not None and claude_version >= (3, 7):
        return STANDARD_REASONING_EFFORTS
    return ()


def reasoning_efforts_for_names(names: Iterable[str]) -> tuple[ReasoningEffort, ...]:
    """Return the richest inferred effort list across endpoint and entity identities."""
    inferred = (reasoning_efforts_by_family(name) for name in names)
    return max(inferred, key=len, default=())


def _version(pattern: re.Pattern[str], value: str) -> tuple[int, int] | None:
    match = pattern.search(value)
    if match is None:
        return None
    return int(match.group(1)), int(match.group(2) or 0)


reasoningEffortsByFamily = reasoning_efforts_by_family
reasoningEffortsForNames = reasoning_efforts_for_names
