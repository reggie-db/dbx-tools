from __future__ import annotations

import json
import os
import tempfile
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import TypeVar

from dbx_tools.core import config

ConfigKey = str | Sequence[str]
T = TypeVar("T")


def config_name(input: ConfigKey, options: config.ConfigOptions | None = None) -> str:
    return config.name(input, options)


def environment_text(
    environment: Mapping[str, str],
    input: ConfigKey,
    options: config.ConfigOptions | None = None,
) -> str | None:
    return _with_environment(
        environment,
        lambda: config.text(input, {**(options or {}), "sources": "env"}),
    )


def config_string(
    configured: object,
    environment: Mapping[str, str],
    input: ConfigKey,
    options: config.ConfigOptions | None = None,
) -> str | None:
    return _with_environment(
        environment,
        lambda: config.string(configured, input, {**(options or {}), "sources": "env"}),
    )


def config_boolean(configured: object) -> bool | None:
    return config.boolean(configured, "POLYGLOT_UNUSED", config.ENV_ONLY)


def config_positive_number(configured: object, fallback: float) -> float:
    return config.positive_number(configured, "POLYGLOT_UNUSED", fallback, config.ENV_ONLY)


def config_positive_int(configured: object, fallback: int) -> int:
    return config.positive_int(configured, "POLYGLOT_UNUSED", fallback, config.ENV_ONLY)


def config_list(configured: str | Sequence[str] | None) -> list[str]:
    return config.list(configured, "POLYGLOT_UNUSED", options=config.ENV_ONLY)


def config_data_values(
    data: Mapping[str, object],
    environment: Mapping[str, str],
    input: ConfigKey,
    sources: Sequence[config.ConfigSource] | None = None,
) -> str | None:
    options: config.ConfigOptions = {"data": data, "scope": ()}
    if sources is not None:
        options["sources"] = sources
    return _with_environment(environment, lambda: config.text(input, options))


def is_databricks_app_env(source: Mapping[str, str | None]) -> bool:
    return config.is_databricks_app_env(source)


def dotenv_values(
    files: Mapping[str, str],
    node_env: str | None,
    cwd: str,
    inputs: Sequence[ConfigKey],
    options: config.ConfigOptions | None = None,
    project_root: bool = True,
    environment: Mapping[str, str] | None = None,
) -> list[str | None]:
    with tempfile.TemporaryDirectory(prefix="dbx-tools-config-polyglot-") as directory:
        root = Path(directory)
        if project_root:
            (root / "package.json").write_text('{"name":"fixture"}\n', encoding="utf-8")
        for relative_path, contents in files.items():
            path = root / relative_path
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(contents, encoding="utf-8")
        working_directory = root / cwd
        working_directory.mkdir(parents=True, exist_ok=True)
        return _with_environment(
            {**_file_source_environment(), "NODE_ENV": node_env, **(environment or {})},
            lambda: _dotenv_results(working_directory, inputs, options),
        )


def dotenv_cached_value(initial: str, updated: str) -> list[str | None]:
    with tempfile.TemporaryDirectory(prefix="dbx-tools-config-polyglot-") as directory:
        root = Path(directory)
        (root / "package.json").write_text('{"name":"fixture"}\n', encoding="utf-8")
        path = root / ".env"
        path.write_text(f"SAMPLE={initial}\n", encoding="utf-8")

        def read_values() -> list[str | None]:
            first = config.text("SAMPLE", {"cwd": str(root), "scope": (), "sources": "dotenv"})
            path.write_text(f"SAMPLE={updated}\n", encoding="utf-8")
            second = config.text("SAMPLE", {"cwd": str(root), "scope": (), "sources": "dotenv"})
            return [first, second]

        return _with_environment(_file_source_environment(), read_values)


def app_values(
    contents: str,
    inputs: Sequence[ConfigKey],
    options: config.ConfigOptions | None = None,
    environment: Mapping[str, str] | None = None,
) -> list[str | None]:
    with tempfile.TemporaryDirectory(prefix="dbx-tools-config-polyglot-") as directory:
        root = Path(directory)
        (root / "package.json").write_text('{"name":"fixture"}\n', encoding="utf-8")
        (root / "app.yaml").write_text(contents, encoding="utf-8")
        return _with_environment(
            {**_file_source_environment(), **(environment or {})},
            lambda: [
                config.text(
                    input,
                    {**(options or {}), "cwd": str(root), "sources": "app"},
                )
                for input in inputs
            ],
        )


def app_cached_value(initial: str, updated: str) -> list[str | None]:
    with tempfile.TemporaryDirectory(prefix="dbx-tools-config-polyglot-") as directory:
        root = Path(directory)
        (root / "package.json").write_text('{"name":"fixture"}\n', encoding="utf-8")
        path = root / "app.yaml"
        path.write_text(f"env:\n  - name: SAMPLE\n    value: {initial}\n", encoding="utf-8")

        def read_values() -> list[str | None]:
            first = config.text("SAMPLE", {"cwd": str(root), "scope": (), "sources": "app"})
            path.write_text(
                f"env:\n  - name: SAMPLE\n    value: {updated}\n",
                encoding="utf-8",
            )
            second = config.text("SAMPLE", {"cwd": str(root), "scope": (), "sources": "app"})
            return [first, second]

        return _with_environment(_file_source_environment(), read_values)


def bundle_values(
    payload: Mapping[str, object],
    status: int,
    inputs: Sequence[ConfigKey],
    options: config.ConfigOptions | None = None,
    environment: Mapping[str, str] | None = None,
    current_working_directory: bool = False,
) -> dict[str, object]:
    with tempfile.TemporaryDirectory(prefix="dbx-tools-config-polyglot-") as directory:
        root = Path(directory)
        (root / "package.json").write_text('{"name":"fixture"}\n', encoding="utf-8")
        (root / "databricks.yml").write_text("bundle: {}\n", encoding="utf-8")
        output = root / ".polyglot-bundle-output"
        counter = root / ".polyglot-bundle-calls"
        output.write_text(json.dumps(payload), encoding="utf-8")
        (root / ".polyglot-bundle-status").write_text(str(status), encoding="utf-8")
        changes = {
            **_file_source_environment(),
            **(environment or {}),
        }
        return _with_environment(
            changes,
            lambda: _bundle_results(root, counter, inputs, options, current_working_directory),
        )


def _dotenv_results(
    cwd: Path,
    inputs: Sequence[ConfigKey],
    options: config.ConfigOptions | None,
) -> list[str | None]:
    return [
        config.text(input, {**(options or {}), "cwd": str(cwd), "sources": "dotenv"})
        for input in inputs
    ]


def _bundle_results(
    root: Path,
    counter: Path,
    inputs: Sequence[ConfigKey],
    options: config.ConfigOptions | None,
    current_working_directory: bool,
) -> dict[str, object]:
    original_cwd = Path.cwd()
    if current_working_directory:
        os.chdir(root)
    try:
        cwd = str(Path.cwd()) if current_working_directory else str(root)
        values = [config.text(input, {**(options or {}), "cwd": cwd}) for input in inputs]
        calls = len(counter.read_text(encoding="utf-8").splitlines()) if counter.exists() else 0
        return {"values": values, "calls": calls}
    finally:
        os.chdir(original_cwd)


def _with_environment(changes: Mapping[str, str | None], callback: Callable[[], T]) -> T:
    original = {key: os.environ.get(key) for key in changes}
    try:
        for key, value in changes.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        return callback()
    finally:
        for key, value in original.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def _file_source_environment() -> dict[str, None]:
    return {
        config.CONFIG_BUNDLE_KEY: None,
        config.CONFIG_APP_KEY: None,
        config.CONFIG_DOTENV_KEY: None,
        config.DATABRICKS_APP_ENV_KEY: None,
        "DATABRICKS_APP_NAME": None,
        "DATABRICKS_APP_PORT": None,
        "DATABRICKS_HOST": None,
    }
