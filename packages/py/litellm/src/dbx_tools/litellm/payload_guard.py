"""Keep request bodies under the Databricks serving request-size limit.

Databricks Model Serving rejects any request whose body exceeds 32 MiB with

    BAD_REQUEST: Server received a request which exceeds maximum allowed
    content length. RequestSize(bytes): <n>, Limit(bytes): 33554432

Chat clients inline uploaded images as base64 ``data:`` URLs and resend the
whole history every turn, so a couple of photos push a request past the limit
and every turn then fails with that opaque error.

This pre-call hook measures the serialized request. When it is over the limit it
downscales base64 images (largest first) by re-encoding them smaller with
Pillow, stopping as soon as the request fits. If the request still does not fit
(or Pillow is unavailable), it raises a clear error naming the size and cap
instead of letting Databricks return the opaque 400.
"""

from __future__ import annotations

import base64
import binascii
import io
import json
import logging
import re
from typing import Any

from litellm.integrations.custom_logger import CustomLogger

logger = logging.getLogger(__name__)

# Databricks Model Serving's request-body cap. Aim below it to leave room for
# the JSON envelope, system prompt, and tool schemas around the images.
_DATABRICKS_LIMIT_BYTES = 32 * 1024 * 1024
_TARGET_BYTES = 30 * 1024 * 1024

# Re-encode dimensions to try, largest first. Each pass shrinks the longest edge
# and lowers JPEG quality; the first pass that brings the request under target
# wins.
_DOWNSCALE_STEPS: tuple[tuple[int, int], ...] = (
    (2048, 80),
    (1536, 75),
    (1024, 70),
    (768, 65),
)

_DATA_URL = re.compile(r"^data:(?P<mime>image/[\w.+-]+);base64,(?P<data>.+)$", re.DOTALL)


class DbxPayloadGuard(CustomLogger):
    """Shrink oversize image payloads before they reach Databricks."""

    async def async_pre_call_hook(
        self,
        *,
        data: dict[str, Any],
        call_type: str,
        **_: Any,
    ) -> dict[str, Any]:
        size = _request_size(data)
        if size <= _TARGET_BYTES:
            return data

        images = _base64_images(data)
        if not images:
            # Text alone is over the limit; there is nothing to downscale.
            _raise_too_large(size, downscaled=False)

        # Shrink the largest images first — that removes the most bytes per pass.
        images.sort(key=lambda ref: len(ref.value()), reverse=True)
        for ref in images:
            _try_downscale(ref)
            if _request_size(data) <= _TARGET_BYTES:
                logger.info(
                    "payload guard: downscaled images to fit (%d -> %d bytes)",
                    size,
                    _request_size(data),
                )
                return data

        final = _request_size(data)
        if final > _DATABRICKS_LIMIT_BYTES:
            _raise_too_large(final, downscaled=True)
        return data


# -- request traversal --------------------------------------------------------


def _request_size(data: dict[str, Any]) -> int:
    """Byte length of the request as it will be serialized to JSON."""
    try:
        return len(json.dumps(data, default=str).encode("utf-8"))
    except (TypeError, ValueError):
        return 0


class _ImageRef:
    """A base64 ``data:`` image found in the request, with in-place replacement.

    OpenAI chat and Responses payloads carry images in a handful of shapes
    (``image_url.url``, a bare ``image_url`` string, Responses ``image_url``).
    Each ref knows how to read its current value and write a replacement back
    into the same slot.
    """

    def __init__(self, container: dict[str, Any], key: str) -> None:
        self._container = container
        self._key = key

    def value(self) -> str:
        current = self._container.get(self._key)
        if isinstance(current, dict):
            url = current.get("url")
            return url if isinstance(url, str) else ""
        return current if isinstance(current, str) else ""

    def set(self, data_url: str) -> None:
        current = self._container.get(self._key)
        if isinstance(current, dict):
            current["url"] = data_url
        else:
            self._container[self._key] = data_url


def _base64_images(data: dict[str, Any]) -> list[_ImageRef]:
    """Every base64 ``data:`` image URL reachable in the request."""
    refs: list[_ImageRef] = []
    _walk(data, refs)
    return [ref for ref in refs if _DATA_URL.match(ref.value())]


def _walk(node: Any, refs: list[_ImageRef]) -> None:
    if isinstance(node, dict):
        for key, value in node.items():
            if key in {"image_url", "url"} and _has_data_url(value):
                refs.append(_ImageRef(node, key))
            else:
                _walk(value, refs)
    elif isinstance(node, list):
        for item in node:
            _walk(item, refs)


def _has_data_url(value: Any) -> bool:
    if isinstance(value, str):
        return value.startswith("data:image/")
    if isinstance(value, dict):
        url = value.get("url")
        return isinstance(url, str) and url.startswith("data:image/")
    return False


# -- downscaling --------------------------------------------------------------


def _try_downscale(ref: _ImageRef) -> None:
    """Replace the image with the smallest re-encoding that is still smaller
    than the original. No-op if Pillow is missing or the data does not decode."""
    match = _DATA_URL.match(ref.value())
    if match is None:
        return
    try:
        raw = base64.b64decode(match.group("data"), validate=True)
    except (binascii.Error, ValueError):
        return

    reencoded = _reencode_smaller(raw)
    if reencoded is None or len(reencoded) >= len(raw):
        return
    encoded = base64.b64encode(reencoded).decode("ascii")
    ref.set(f"data:image/jpeg;base64,{encoded}")


def _reencode_smaller(raw: bytes) -> bytes | None:
    """Return the smallest JPEG re-encoding across the downscale steps, or None
    when Pillow is unavailable or the bytes are not a decodable image."""
    try:
        from PIL import Image
    except ImportError:
        logger.warning("payload guard: Pillow not installed; cannot downscale images")
        return None

    try:
        with Image.open(io.BytesIO(raw)) as image:
            image.load()
            rgb = image.convert("RGB")
    except OSError:
        return None

    best: bytes | None = None
    for max_edge, quality in _DOWNSCALE_STEPS:
        candidate = rgb.copy()
        candidate.thumbnail((max_edge, max_edge))
        buffer = io.BytesIO()
        candidate.save(buffer, format="JPEG", quality=quality, optimize=True)
        encoded = buffer.getvalue()
        if best is None or len(encoded) < len(best):
            best = encoded
    return best


def _raise_too_large(size: int, *, downscaled: bool) -> None:
    limit_mib = _DATABRICKS_LIMIT_BYTES / 1024 / 1024
    size_mib = size / 1024 / 1024
    detail = (
        "even after downscaling images"
        if downscaled
        else "and it has no images to downscale"
    )
    raise ValueError(
        f"Request body is {size_mib:.1f} MiB, over the Databricks "
        f"{limit_mib:.0f} MiB limit {detail}. Remove or shrink attachments and retry."
    )


dbx_payload_guard = DbxPayloadGuard()
