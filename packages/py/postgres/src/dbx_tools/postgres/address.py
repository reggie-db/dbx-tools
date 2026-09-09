from typing import Literal, TypeAlias

from dbx_tools.databricks import (
    ParsedAddress,
    parse_address,
    parse_resource_path,
)
from dbx_tools.databricks import (
    SslMode as NativeSslMode,
)

"""Lakebase address types and parsers backed by the Databricks Rust bindings."""

SslMode = Literal["require", "disable", "prefer"]
SSL_MODES: tuple[SslMode, ...] = ("require", "disable", "prefer")
LakebaseConnectionInputs: TypeAlias = ParsedAddress

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
