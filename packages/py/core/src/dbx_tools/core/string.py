from __future__ import annotations

import re


def to_identifier(*values: object, delimiter: str = "-") -> str:
    """Match TypeScript identifier tokenization with an overridable delimiter."""
    tokens: list[str] = []
    for value in values:
        text_value = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1 \2", str(value))
        text_value = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", text_value)
        tokens.extend(token.lower() for token in re.findall(r"[A-Za-z0-9]+", text_value))
    return delimiter.join(tokens)
