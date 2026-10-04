from __future__ import annotations

import asyncio
import hashlib
import os
import shutil
import tarfile
import tempfile
import urllib.request
from pathlib import Path

from .locks import FileLeaseLocks


async def ensure_binary(request: object) -> None:
    """Install one checksum-pinned archive executable under a file lease."""
    values = dict(request)
    destination = Path(str(values["destination"])).expanduser().resolve()
    locks = FileLeaseLocks(destination.parent / ".locks")
    lease = await locks.acquire(str(destination), 30_000)
    try:
        if destination.is_file() and (os.name == "nt" or os.access(destination, os.X_OK)):
            return
        await asyncio.to_thread(
            _install_binary,
            str(values["url"]),
            str(values.get("sha256") or ""),
            destination,
            str(values["executable"]),
        )
    finally:
        await locks.release(lease)


def _install_binary(url: str, sha256: str, destination: Path, executable: str) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="dbx-tools-bin-") as temporary:
        archive = Path(temporary) / "download"
        with urllib.request.urlopen(url, timeout=30) as response:
            content = response.read()
        if sha256 and hashlib.sha256(content).hexdigest().lower() != sha256.lower():
            raise RuntimeError(f"Binary download digest mismatch: {url}")
        archive.write_bytes(content)
        with tarfile.open(archive, mode="r:*") as package:
            member = next(
                (
                    candidate
                    for candidate in package.getmembers()
                    if candidate.isfile() and Path(candidate.name).name == executable
                ),
                None,
            )
            if member is None:
                raise RuntimeError(f"Archive does not contain {executable}")
            source = package.extractfile(member)
            if source is None:
                raise RuntimeError(f"Could not read {executable} from archive")
            staged = Path(temporary) / executable
            with staged.open("wb") as target:
                shutil.copyfileobj(source, target)
            staged.chmod(0o755)
            staged.replace(destination)
