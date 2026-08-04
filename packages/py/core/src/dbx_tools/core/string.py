from __future__ import annotations

import re


def to_identifier(*values: object) -> str:
    """Tokenize values into the readable identifier form used by the Node bus."""
    tokens: list[str] = []
    for value in values:
        text_value = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", str(value))
        tokens.extend(token.lower() for token in re.findall(r"[A-Za-z0-9]+", text_value))
    return "_".join(tokens)
