"""LiteLLM config-file import shim for the packaged provider."""

from dbx_tools.litellm.provider import dbx_provider

__all__ = ["dbx_provider"]
