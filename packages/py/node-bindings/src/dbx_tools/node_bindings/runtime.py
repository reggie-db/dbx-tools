from __future__ import annotations

import hashlib
import os
import platform
import tempfile
from os import path as os_path
from pathlib import Path
from typing import Any

import pythonmonkey as pm

from .binary import ensure_binary
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


async def _run_process(
    command: str,
    args: object,
    environment: object | None,
    input_text: str | None,
) -> object:
    return await run_process(
        command,
        [str(argument) for argument in args],
        env=dict(environment) if environment is not None else None,
        input=input_text,
    )


def _resolve_path(parts: object) -> str:
    values = [str(part) for part in parts]
    return os_path.abspath(os_path.join(*values)) if values else os.getcwd()


def _install_runtime() -> None:
    global _INITIALIZED
    if _INITIALIZED:
        return
    host = {
        "core": {"ensureBinary": ensure_binary},
        "crypto": {"sha256": lambda value: hashlib.sha256(str(value).encode()).hexdigest()},
        "file": {
            "exists": lambda value: Path(str(value)).exists(),
            "readTextSync": _read_text_sync,
        },
        "os": {
            "homedir": lambda: str(Path.home()),
            "tmpdir": tempfile.gettempdir,
        },
        "path": {
            "isAbsolute": os_path.isabs,
            "join": lambda parts: os_path.join(*(str(part) for part in parts)),
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
