from __future__ import annotations

import base64
import io

import pytest
from dbx_tools.litellm.payload_guard import (
    _DATABRICKS_LIMIT_BYTES,
    _request_size,
    dbx_payload_guard,
)
from PIL import Image


def _data_url(width: int, height: int, color: tuple[int, int, int]) -> str:
    """A PNG data URL of a solid color. PNG of noise is large, so use noise to
    make the payload genuinely oversized when needed."""
    image = Image.new("RGB", (width, height), color)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def _noisy_data_url(width: int, height: int) -> str:
    """A PNG of random noise — incompressible, so it dominates the request size."""
    import os

    image = Image.frombytes("RGB", (width, height), os.urandom(width * height * 3))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


async def test_small_request_passes_through_unchanged() -> None:
    data = {
        "model": "dbx/databricks-claude-opus-4-8",
        "messages": [{"role": "user", "content": "hello"}],
    }
    before = dict(data)

    result = await dbx_payload_guard.async_pre_call_hook(data=data, call_type="acompletion")

    assert result == before


async def test_oversize_image_request_is_downscaled_to_fit() -> None:
    # One noisy image large enough to push the request over the limit.
    big = _noisy_data_url(4000, 4000)
    data = {
        "model": "dbx/databricks-claude-opus-4-8",
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "describe this"},
                    {"type": "image_url", "image_url": {"url": big}},
                ],
            }
        ],
    }
    assert _request_size(data) > _DATABRICKS_LIMIT_BYTES

    result = await dbx_payload_guard.async_pre_call_hook(data=data, call_type="acompletion")

    assert _request_size(result) <= _DATABRICKS_LIMIT_BYTES
    url = result["messages"][0]["content"][1]["image_url"]["url"]
    assert url.startswith("data:image/jpeg;base64,")


async def test_oversize_text_only_request_raises_clear_error() -> None:
    data = {
        "model": "dbx/databricks-claude-opus-4-8",
        "messages": [{"role": "user", "content": "x" * (_DATABRICKS_LIMIT_BYTES + 1)}],
    }

    with pytest.raises(ValueError, match="over the Databricks"):
        await dbx_payload_guard.async_pre_call_hook(data=data, call_type="acompletion")


async def test_downscales_bare_string_image_url_shape() -> None:
    # Responses-style content uses a bare `image_url` string rather than a dict.
    data = {
        "model": "dbx/databricks-claude-opus-4-8",
        "input": [
            {
                "role": "user",
                "content": [{"type": "input_image", "image_url": _noisy_data_url(4000, 4000)}],
            }
        ],
    }
    assert _request_size(data) > _DATABRICKS_LIMIT_BYTES

    result = await dbx_payload_guard.async_pre_call_hook(data=data, call_type="aresponses")

    assert _request_size(result) <= _DATABRICKS_LIMIT_BYTES
    assert result["input"][0]["content"][0]["image_url"].startswith("data:image/jpeg;base64,")
