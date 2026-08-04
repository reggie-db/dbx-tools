from __future__ import annotations

_BASE32_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"


def fnv_hash(value: str, *, length: int = 6) -> str:
    """Match TypeScript ``fnvHashWithOptions`` for one string value."""
    if length <= 0:
        raise ValueError("length must be greater than zero")
    digest = 0x811C9DC5
    for token in ("[", "string:", value, ",", "]"):
        encoded = token.encode("utf-16-le", "surrogatepass")
        for index in range(0, len(encoded), 2):
            code_unit = encoded[index] | (encoded[index + 1] << 8)
            digest ^= code_unit
            digest = (digest * 0x01000193) & 0xFFFFFFFF
    encoded_digest = _to_base32(digest).rjust(7, _BASE32_ALPHABET[0])
    return encoded_digest[: min(length, 7)]


def _to_base32(value: int) -> str:
    if value == 0:
        return _BASE32_ALPHABET[0]
    encoded = ""
    while value:
        encoded = _BASE32_ALPHABET[value & 31] + encoded
        value >>= 5
    return encoded
