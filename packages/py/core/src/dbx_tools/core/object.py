from __future__ import annotations

import math
from collections.abc import Mapping
from datetime import date, datetime


def to_stable_key(value: object, seen: set[int] | None = None) -> str:
    """Build the Python equivalent of shared-core's strict stable identity key."""
    if value is None:
        return "null"
    if isinstance(value, str):
        utf16_length = len(value.encode("utf-16-le", "surrogatepass")) // 2
        return f"string:{utf16_length}:{value}"
    if isinstance(value, bool):
        return f"boolean:{str(value).lower()}"
    if isinstance(value, int):
        return f"number:{value}"
    if isinstance(value, float):
        if not math.isfinite(value):
            raise TypeError("Stable keys require finite numbers")
        if value == 0 and math.copysign(1, value) < 0:
            return "number:-0"
        return f"number:{format(value, '.15g')}"
    if isinstance(value, (datetime, date)):
        timestamp = value.isoformat()
        if isinstance(value, datetime) and value.tzinfo is not None:
            timestamp = timestamp.replace("+00:00", "Z")
        return f"date:{timestamp}"
    seen = seen or set()
    identity = id(value)
    if identity in seen:
        raise TypeError("Stable keys cannot contain cycles")
    seen.add(identity)
    try:
        if isinstance(value, (list, tuple)):
            return f"array:[{','.join(to_stable_key(item, seen) for item in value)}]"
        if isinstance(value, (set, frozenset)):
            return f"set:[{','.join(sorted(to_stable_key(item, seen) for item in value))}]"
        if isinstance(value, Mapping):
            entries = sorted(
                f"{to_stable_key(key, seen)}={to_stable_key(item, seen)}"
                for key, item in value.items()
            )
            return f"object:{{{','.join(entries)}}}"
    finally:
        seen.remove(identity)
    raise TypeError(f"Unsupported stable key type: {type(value).__name__}")
