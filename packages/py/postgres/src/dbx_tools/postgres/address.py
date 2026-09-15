"""Lakebase address types and parsers backed by the Databricks Rust bindings."""

from typing import Literal, TypeAlias

from dbx_tools.core_rs.bindings import (
    ParsedAddress,
    parse_address,
    parse_resource_path,
)
from dbx_tools.core_rs.bindings import (
    SslMode as NativeSslMode,
)

SslMode = Literal["require", "disable", "prefer"]
"""Accepted PostgreSQL SSL modes."""

SSL_MODES: tuple[SslMode, ...] = ("require", "disable", "prefer")
"""All accepted values for :class:`SslMode`."""

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
