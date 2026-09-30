"""Lakebase address types and parsers backed by the Databricks Rust bindings."""

from typing import TypeAlias

from dbx_tools.core_rs.bindings import (
    ParsedAddress,
    parse_address,
    parse_resource_path,
)
from dbx_tools.core_rs.bindings import (
    SslMode as NativeSslMode,
)

SslMode: TypeAlias = NativeSslMode
"""Generated PostgreSQL SSL mode enum."""

SSL_MODES: tuple[str, ...] = tuple(mode.name.lower() for mode in NativeSslMode)
"""Accepted configuration spellings derived from :class:`SslMode`."""

LakebaseConnectionInputs: TypeAlias = ParsedAddress
"""Resolved address inputs returned by the native parser."""

parseAddress = parse_address
parseResourcePath = parse_resource_path

__all__ = [
    "SSL_MODES",
    "LakebaseConnectionInputs",
    "NativeSslMode",
    "ParsedAddress",
    "SslMode",
    "parseAddress",
    "parseResourcePath",
    "parse_address",
    "parse_resource_path",
]
