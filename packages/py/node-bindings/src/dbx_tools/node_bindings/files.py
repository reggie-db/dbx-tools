from __future__ import annotations

import asyncio
import uuid
from pathlib import Path


async def ensure_directory(path: Path, *, mode: int = 0o700) -> None:
    """Create a directory without blocking the event loop."""
    await asyncio.to_thread(path.mkdir, parents=True, exist_ok=True, mode=mode)


async def read_text(path: Path, *, default: str | None = None) -> str | None:
    """Read text asynchronously and return a caller-supplied missing-file value."""
    try:
        return await asyncio.to_thread(path.read_text, encoding="utf-8")
    except FileNotFoundError:
        return default


async def atomic_write_text(path: Path, content: str, *, mode: int = 0o600) -> None:
    """Atomically replace a UTF-8 text file."""
    await ensure_directory(path.parent)
    temporary = path.parent / f".{path.name}-{uuid.uuid4().hex}.tmp"
    try:
        await asyncio.to_thread(
            temporary.write_text,
            content,
            encoding="utf-8",
        )
        await asyncio.to_thread(temporary.chmod, mode)
        await asyncio.to_thread(temporary.replace, path)
    finally:
        try:
            await asyncio.to_thread(temporary.unlink)
        except FileNotFoundError:
            pass
