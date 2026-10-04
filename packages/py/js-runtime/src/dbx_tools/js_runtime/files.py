from __future__ import annotations

import asyncio
import json
import uuid
from pathlib import Path
from typing import Any


async def ensure_directory(path: Path, *, mode: int = 0o700) -> None:
    """Create a directory without blocking the event loop."""
    await asyncio.to_thread(path.mkdir, parents=True, exist_ok=True, mode=mode)


async def read_json(path: Path, *, default: Any = None) -> Any:
    """Read JSON asynchronously and return a caller-supplied missing-file value."""
    try:
        text = await asyncio.to_thread(path.read_text, encoding="utf-8")
    except FileNotFoundError:
        return default
    return json.loads(text)


async def read_text(path: Path, *, default: str | None = None) -> str | None:
    """Read text asynchronously and return a caller-supplied missing-file value."""
    try:
        return await asyncio.to_thread(path.read_text, encoding="utf-8")
    except FileNotFoundError:
        return default


async def atomic_write_json(path: Path, value: Any, *, mode: int = 0o600) -> None:
    """Atomically replace a JSON file with deterministic formatted content."""
    await ensure_directory(path.parent)
    temporary = path.parent / f".{path.name}-{uuid.uuid4().hex}.tmp"
    try:
        await asyncio.to_thread(
            temporary.write_text,
            f"{json.dumps(value, indent=2)}\n",
            encoding="utf-8",
        )
        await asyncio.to_thread(temporary.chmod, mode)
        await asyncio.to_thread(temporary.replace, path)
    finally:
        try:
            await asyncio.to_thread(temporary.unlink)
        except FileNotFoundError:
            pass
