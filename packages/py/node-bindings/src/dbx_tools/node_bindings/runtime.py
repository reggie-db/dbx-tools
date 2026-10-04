from __future__ import annotations

import hashlib
import os
import platform
import shutil
import tempfile
from os import path as os_path
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

import httpx
import pythonmonkey as pm

from .process import run_process

_INITIALIZED = False


def _node_platform() -> str:
    return {"darwin": "darwin", "linux": "linux", "windows": "win32"}.get(
        platform.system().lower(),
        platform.system().lower(),
    )


def _node_arch() -> str:
    return {
        "aarch64": "arm64",
        "amd64": "x64",
        "arm64": "arm64",
        "x86_64": "x64",
    }.get(platform.machine().lower(), platform.machine().lower())


def _read_text_sync(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def _mkdir(path: str, recursive: bool) -> bool:
    try:
        Path(path).mkdir(parents=recursive, exist_ok=recursive)
        return True
    except FileExistsError:
        return False


def _mkdtemp(prefix: str) -> str:
    value = Path(prefix)
    return tempfile.mkdtemp(prefix=value.name, dir=str(value.parent))


def _stat(path: str) -> dict[str, object]:
    value = Path(path).stat()
    return {
        "directory": Path(path).is_dir(),
        "file": Path(path).is_file(),
        "mode": value.st_mode,
        "mtimeMs": value.st_mtime * 1000,
        "size": value.st_size,
    }


def _remove(path: str, recursive: bool, force: bool) -> None:
    target = Path(path)
    try:
        if target.is_dir() and not target.is_symlink():
            shutil.rmtree(target) if recursive else target.rmdir()
        else:
            target.unlink()
    except FileNotFoundError:
        if not force:
            raise


def _write_bytes(path: str, content: object, mode: int | None) -> None:
    target = Path(path)
    target.write_bytes(bytes(int(value) for value in content))
    if mode is not None:
        target.chmod(mode)


def _file_url_to_path(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme != "file":
        raise ValueError(f"URL must use file: scheme: {url}")
    return unquote(parsed.path)


async def _fetch(url: str) -> dict[str, object]:
    async with httpx.AsyncClient(follow_redirects=True, timeout=30) as client:
        response = await client.get(url)
    return {
        "status": response.status_code,
        "headers": dict(response.headers),
        "body": list(response.content),
    }


async def _run_process(
    command: str,
    args: object,
    environment: object | None,
    input_text: str | None,
    timeout_ms: int | None,
) -> object:
    return await run_process(
        command,
        [str(argument) for argument in args],
        env=dict(environment) if environment is not None else None,
        input=input_text,
        timeout_ms=timeout_ms,
    )


def _resolve_path(parts: object) -> str:
    values = [str(part) for part in parts]
    return os_path.abspath(os_path.join(*values)) if values else os.getcwd()


def _install_runtime() -> None:
    global _INITIALIZED
    if _INITIALIZED:
        return
    host = {
        "crypto": {
            "randomBytes": lambda length: list(os.urandom(int(length))),
            "sha256": lambda content: hashlib.sha256(
                bytes(int(value) for value in content),
            ).hexdigest(),
        },
        "file": {
            "chmod": lambda path, mode: Path(str(path)).chmod(int(mode)),
            "copy": lambda source, destination: shutil.copyfile(
                str(source),
                str(destination),
            ),
            "exists": lambda value: Path(str(value)).exists(),
            "mkdir": lambda path, recursive: _mkdir(str(path), bool(recursive)),
            "mkdtemp": lambda prefix: _mkdtemp(str(prefix)),
            "readBytes": lambda path: list(Path(str(path)).read_bytes()),
            "readDirectory": lambda path: [
                {
                    "name": child.name,
                    "directory": child.is_dir(),
                    "file": child.is_file(),
                }
                for child in Path(str(path)).iterdir()
            ],
            "readTextSync": _read_text_sync,
            "realpath": lambda path: str(Path(str(path)).resolve(strict=True)),
            "remove": lambda path, recursive, force: _remove(
                str(path),
                bool(recursive),
                bool(force),
            ),
            "rename": lambda source, destination: Path(str(source)).replace(
                str(destination),
            ),
            "stat": lambda path: _stat(str(path)),
            "touch": lambda path, atime_ms, mtime_ms: os.utime(
                str(path),
                (float(atime_ms) / 1000, float(mtime_ms) / 1000),
            ),
            "writeBytes": lambda path, content, mode=None: _write_bytes(
                str(path),
                content,
                int(mode) if mode is not None else None,
            ),
        },
        "http": {"fetch": _fetch},
        "os": {
            "homedir": lambda: str(Path.home()),
            "tmpdir": tempfile.gettempdir,
        },
        "path": {
            "basename": os_path.basename,
            "dirname": os_path.dirname,
            "fileUrlToPath": _file_url_to_path,
            "isAbsolute": os_path.isabs,
            "join": lambda parts: os_path.join(*(str(part) for part in parts)),
            "relative": lambda source, destination: os_path.relpath(
                str(destination),
                str(source),
            ),
            "resolve": _resolve_path,
        },
        "process": {"run": _run_process},
    }
    pm.eval(
        """
        (host, environment, platform, arch, cwd) => {
          globalThis.global = globalThis;
          globalThis.self = globalThis;
          globalThis.window = globalThis;
          globalThis.__dbxToolsPython = host;
          globalThis.Buffer = globalThis.Buffer || {
            byteLength: value => new TextEncoder().encode(String(value)).byteLength,
            from: value => value instanceof ArrayBuffer
              ? new Uint8Array(value)
              : ArrayBuffer.isView(value)
                ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
                : new TextEncoder().encode(String(value)),
          };
          globalThis.fetch = globalThis.fetch || (async url => {
            const result = await host.http.fetch(String(url));
            return {
              ok: result.status >= 200 && result.status < 300,
              status: result.status,
              headers: result.headers,
              arrayBuffer: async () => Uint8Array.from(result.body).buffer,
            };
          });
          globalThis.process = {
            arch,
            argv: [],
            browser: true,
            cwd: () => cwd,
            env: environment,
            nextTick: (callback, ...args) => Promise.resolve().then(() => callback(...args)),
            platform,
            version: "v22.0.0",
            versions: {},
          };
          if (typeof globalThis.AbortController === "undefined") {
            globalThis.AbortController = class AbortController {
              constructor() {
                const listeners = [];
                this.signal = {
                  aborted: false,
                  addEventListener: (name, listener) => {
                    if (name === "abort") listeners.push(listener);
                  },
                };
                this.abort = () => {
                  if (this.signal.aborted) return;
                  this.signal.aborted = true;
                  for (const listener of listeners) listener();
                };
              }
            };
          }
        }
        """,
    )(host, dict(os.environ), _node_platform(), _node_arch(), os.getcwd())
    _INITIALIZED = True


def require_runtime(module_file: str | Path, name: str = "_runtime.js") -> Any:
    """Load a committed CommonJS bundle beside a Python module."""
    _install_runtime()
    return pm.require(str(Path(module_file).resolve().with_name(name)))
