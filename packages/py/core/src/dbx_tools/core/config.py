from __future__ import annotations

import builtins
import json
import math
import os
import re
import subprocess
from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, TypedDict
from urllib.parse import urlparse

from .string import to_identifier

ConfigKey = str | Sequence[str]
ConfigSource = Literal["env", "dotenv", "bundle"]


class ConfigOptions(TypedDict, total=False):
    scope: str | Sequence[str]
    prefix: str | Sequence[str]
    cwd: str
    sources: ConfigSource | Sequence[ConfigSource]


@dataclass(frozen=True)
class ConfigFile:
    path: str
    data: dict[str, object]


@dataclass(frozen=True)
class _ConfigValue:
    key: str
    source: ConfigSource
    value: str


DEFAULT_SCOPE = "DBX_TOOLS"
DEFAULT_SOURCES: tuple[ConfigSource, ...] = ("env", "dotenv", "bundle")
BUNDLE_FILE_NAMES = ("databricks.yml", "databricks.yaml")
DOTENV_FILE_NAME = ".env"
NODE_ENV_ALTERNATIVES = {
    "production": ("prod",),
    "development": ("dev",),
}
ROOT_MARKERS = (
    ".projenrc.ts",
    ".projenrc.js",
    ".projenrc.mjs",
    ".projenrc.cjs",
    "package.json",
)
MAX_TCP_PORT = 65_535
DATABRICKS_APP_ENV_KEY = "DBX_TOOLS_DATABRICKS_APP_ENV"
CONFIG_DOTENV_KEY = "DBX_TOOLS_CONFIG_DOTENV"
CONFIG_BUNDLE_KEY = "DBX_TOOLS_CONFIG_BUNDLE"
ENV_ONLY: ConfigOptions = {"scope": (), "sources": "env"}

_CACHE: dict[tuple[str, ...], object] = {}
_NUMBER_PATTERN = re.compile(
    r"^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(%)?$",
    re.IGNORECASE,
)
_INTERPOLATION_PATTERN = re.compile(r"\$\{[^}]+\}")
_ENV_NAME_PATTERN = re.compile(r"[A-Za-z0-9_.-]+")


def clear_cache() -> None:
    _CACHE.clear()


def is_databricks_app_env(source: Mapping[str, str | None] | None = None) -> bool:
    values = os.environ if source is None else source
    override = _to_boolean(values.get(DATABRICKS_APP_ENV_KEY))
    if override is not None:
        return override
    app_name = _trim_to_none(values.get("DATABRICKS_APP_NAME"))
    host = _trim_to_none(values.get("DATABRICKS_HOST"))
    port = _trim_to_none(values.get("DATABRICKS_APP_PORT"))
    if app_name is None or host is None or port is None:
        return False
    try:
        if urlparse(host).scheme not in {"http", "https"}:
            return False
    except ValueError:
        return False
    port_number = _to_number(port)
    return port_number is not None and port_number.is_integer() and 1 <= port_number <= MAX_TCP_PORT


def text(input: ConfigKey, options: ConfigOptions | None = None) -> str | None:
    return next((_value.value for _value in _values(input, options or {})), None)


def name(input: ConfigKey, options: ConfigOptions | None = None) -> str:
    candidates = _keys(input, options or {})
    return candidates[0] if candidates else ""


def string(
    configured: object,
    input: ConfigKey,
    options: ConfigOptions | None = None,
) -> str | None:
    return _trim_to_none(configured) or text(input, options)


def boolean(
    configured: object,
    input: ConfigKey,
    options: ConfigOptions | None = None,
) -> bool | None:
    resolved = _to_boolean(configured)
    return resolved if resolved is not None else _to_boolean(text(input, options))


def positive_number(
    configured: object,
    input: ConfigKey,
    fallback: float,
    options: ConfigOptions | None = None,
) -> float:
    return _to_positive_number(configured) or _to_positive_number(text(input, options)) or fallback


def positive_int(
    configured: object,
    input: ConfigKey,
    fallback: int,
    options: ConfigOptions | None = None,
) -> int:
    return math.floor(positive_number(configured, input, fallback, options))


def list(
    configured: str | Sequence[str] | None,
    input: ConfigKey,
    transform: Callable[[str], str] | None = None,
    options: ConfigOptions | None = None,
) -> builtins.list[str]:
    from_config = _parse_list(configured, transform)
    return from_config or _parse_list(text(input, options), transform)


def bundle_file(cwd: str | None = None) -> ConfigFile | None:
    production = _trim_to_none(os.environ.get("NODE_ENV"))
    default_enabled = (production or "").lower() != "production" and not is_databricks_app_env()
    if not _file_source_enabled(CONFIG_BUNDLE_KEY, default_enabled):
        return None
    return _cached(("config", "bundle"), _load_bundle_file, cwd)


def _keys(input: ConfigKey, options: ConfigOptions) -> builtins.list[str]:
    scopes = _sequence(options.get("scope", DEFAULT_SCOPE))
    prefixes = _sequence(options["prefix"]) if "prefix" in options else []
    result: builtins.list[str] = []
    for key in _sequence(input):
        prefixed = [_join(prefix, key) for prefix in prefixes] if prefixes else [key]
        candidates = [
            *(_join(scope, candidate) for scope in scopes for candidate in prefixed),
            *prefixed,
            key,
        ]
        for candidate in candidates:
            if candidate and candidate not in result:
                result.append(candidate)
    return result


def _values(input: ConfigKey, options: ConfigOptions) -> Iterator[_ConfigValue]:
    candidates = _keys(input, options)
    sources = _sequence(options.get("sources", DEFAULT_SOURCES))
    cwd = options.get("cwd")
    for source in sources:
        if source not in DEFAULT_SOURCES:
            continue
        for values in _read(source, cwd):
            for key in candidates:
                value = _trim_to_none(values.get(key))
                if value is not None:
                    yield _ConfigValue(key=key, source=source, value=value)


def _read(source: ConfigSource, cwd: str | None) -> Iterator[Mapping[str, object]]:
    if source == "env":
        yield os.environ
    elif source == "dotenv":
        yield _dotenv(cwd)
    else:
        bundle = bundle_file(cwd)
        if bundle is not None:
            yield _bundle_app(bundle.data)
            yield _bundle_variables(bundle.data)


def _dotenv(cwd: str | None) -> dict[str, str]:
    if not _file_source_enabled(CONFIG_DOTENV_KEY):
        return {}
    environments = _node_env_names(os.environ.get("NODE_ENV"))
    return _cached(
        ("config", "dotenv", *environments),
        lambda resolved: _load_dotenv(resolved, environments),
        cwd,
    )


def _node_env_names(node_env: object) -> builtins.list[str]:
    value = _trim_to_none(node_env)
    if value is None:
        return []
    environment = value.lower()
    if re.fullmatch(r"[a-z0-9_-]+", environment) is None:
        return []
    for canonical, alternatives in NODE_ENV_ALTERNATIVES.items():
        if environment == canonical or environment in alternatives:
            return _distinct([environment, canonical, *alternatives])
    return [environment]


def _find_config_file(cwd: str, names: Sequence[str]) -> str | None:
    start = Path(cwd).resolve()
    root = _project_root(start)
    boundary = root if root is not None and _is_relative_to(start, root) else None
    directory = start
    while True:
        for file_name in names:
            candidate = directory / file_name
            try:
                if candidate.is_file():
                    return str(candidate)
            except OSError:
                pass
        if boundary is None or directory == boundary:
            return None
        directory = directory.parent


def _file_source_enabled(key: str, fallback: bool | None = None) -> bool:
    override = _to_boolean(os.environ.get(key))
    if override is not None:
        return override
    return not is_databricks_app_env() if fallback is None else fallback


def _load_dotenv(cwd: str | None, environments: Sequence[str]) -> dict[str, str]:
    names = [
        *(f"{DOTENV_FILE_NAME}.{environment}" for environment in environments),
        DOTENV_FILE_NAME,
    ]
    path = _find_config_file(cwd or ".", names)
    if path is None:
        return {}
    try:
        return _parse_env(Path(path).read_text(encoding="utf-8"))
    except (OSError, UnicodeError):
        return {}


def _load_bundle_file(cwd: str | None) -> ConfigFile | None:
    path = _find_config_file(cwd or ".", BUNDLE_FILE_NAMES)
    if path is None:
        return None
    try:
        result = subprocess.run(
            ["databricks", "bundle", "validate", "--output", "json"],
            cwd=str(Path(path).parent),
            check=False,
            capture_output=True,
            text=True,
        )
    except OSError:
        return None
    output = _trim_to_none(result.stdout)
    if output is None:
        return None
    try:
        data = json.loads(output)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    return ConfigFile(path=path, data=data)


def _bundle_app(input: object) -> dict[str, str]:
    if not isinstance(input, Mapping):
        return {}
    resources = input.get("resources")
    if not isinstance(resources, Mapping):
        return {}
    apps = resources.get("apps")
    if not isinstance(apps, Mapping) or not all(_valid_bundle_app(app) for app in apps.values()):
        return {}
    if len(apps) != 1:
        return {}
    app = next(iter(apps.values()))
    if not isinstance(app, Mapping):
        return {}
    config = app.get("config")
    if not isinstance(config, Mapping):
        return {}
    entries = config.get("env")
    if not isinstance(entries, builtins.list):
        return {}
    result: dict[str, str] = {}
    for entry in entries:
        if not isinstance(entry, Mapping):
            continue
        key = _resolved_string(entry.get("name"))
        value = _resolved_string(entry.get("value"))
        if key is not None and value is not None:
            result[key] = value
    return result


def _bundle_variables(input: object) -> dict[str, str]:
    if not isinstance(input, Mapping):
        return {}
    variables = input.get("variables")
    if not isinstance(variables, Mapping):
        return {}
    if not all(
        isinstance(variable, Mapping)
        and _optional_string(variable, "default")
        and _optional_string(variable, "value")
        for variable in variables.values()
    ):
        return {}
    result: dict[str, str] = {}
    for variable_name, variable in variables.items():
        if not isinstance(variable_name, str) or not isinstance(variable, Mapping):
            continue
        key = to_identifier(variable_name, delimiter="_").upper()
        value = _resolved_string(variable.get("value")) or _resolved_string(variable.get("default"))
        if key and value is not None:
            result[key] = value
    return result


def _valid_bundle_app(app: object) -> bool:
    if not isinstance(app, Mapping):
        return False
    if "name" in app and _resolved_string(app.get("name")) is None:
        return False
    if not _optional_string(app, "source_code_path"):
        return False
    config = app.get("config")
    if config is not None:
        if not isinstance(config, Mapping):
            return False
        entries = config.get("env")
        if entries is not None:
            if not isinstance(entries, builtins.list):
                return False
            for entry in entries:
                if not isinstance(entry, Mapping):
                    return False
                if "name" in entry and _resolved_string(entry.get("name")) is None:
                    return False
                if not _optional_string(entry, "value"):
                    return False
                if "value_from" in entry and _resolved_string(entry.get("value_from")) is None:
                    return False
    resources = app.get("resources")
    if resources is not None:
        if not isinstance(resources, builtins.list):
            return False
        for resource in resources:
            if not isinstance(resource, Mapping):
                return False
            if "name" in resource and _resolved_string(resource.get("name")) is None:
                return False
    return True


def _optional_string(value: Mapping[object, object], key: str) -> bool:
    return key not in value or isinstance(value.get(key), str)


def _resolved_string(value: object) -> str | None:
    resolved = _trim_to_none(value)
    if resolved is None or _INTERPOLATION_PATTERN.search(resolved):
        return None
    return resolved


def _project_root(cwd: Path) -> Path | None:
    current = cwd if cwd.is_dir() else cwd.parent
    boundaries = {
        path
        for path in (
            _command_directory("npm", ["prefix"], cwd),
            _command_directory("git", ["rev-parse", "--show-toplevel"], cwd),
        )
        if path is not None
    }
    best: tuple[Path, int] | None = None
    while True:
        for priority, marker in enumerate(ROOT_MARKERS):
            try:
                found = (current / marker).is_file()
            except OSError:
                found = False
            if found:
                if (
                    best is None
                    or priority < best[1]
                    or (priority == best[1] and len(str(current)) < len(str(best[0])))
                ):
                    best = (current, priority)
                break
        if not boundaries and best is not None:
            return best[0]
        if current in boundaries:
            return best[0] if best is not None else None
        if current.parent == current:
            return best[0] if best is not None else None
        current = current.parent


def _command_directory(command: str, arguments: Sequence[str], cwd: Path) -> Path | None:
    try:
        result = subprocess.run(
            [command, *arguments],
            cwd=str(cwd),
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
        )
    except OSError:
        return None
    output = _trim_to_none(result.stdout)
    if result.returncode != 0 or output is None:
        return None
    path = Path(output)
    try:
        return path.resolve() if path.is_dir() else None
    except OSError:
        return None


def _parse_env(source: str) -> dict[str, str]:
    result: dict[str, str] = {}
    index = 0
    length = len(source)
    while index < length:
        while index < length and source[index] in " \t\r\n":
            index += 1
        if index >= length:
            break
        if source[index] == "#":
            index = _next_line(source, index)
            continue
        if source.startswith("export", index):
            after_export = index + len("export")
            if after_export < length and source[after_export] in " \t":
                index = after_export
                while index < length and source[index] in " \t":
                    index += 1
        match = _ENV_NAME_PATTERN.match(source, index)
        if match is None:
            index = _next_line(source, index)
            continue
        key = match.group(0)
        index = match.end()
        while index < length and source[index] in " \t":
            index += 1
        if index >= length or source[index] != "=":
            index = _next_line(source, index)
            continue
        index += 1
        while index < length and source[index] in " \t":
            index += 1
        if (
            index < length
            and source[index] in "'\"`"
            and source.find(source[index], index + 1) >= 0
        ):
            quote = source[index]
            index += 1
            start = index
            while index < length and source[index] != quote:
                index += 1
            value = source[start:index]
            if quote == '"':
                value = value.replace("\\n", "\n").replace("\\r", "\r")
            if index < length:
                index += 1
            index = _next_line(source, index)
        else:
            start = index
            while index < length and source[index] not in "\r\n#":
                index += 1
            value = source[start:index].strip()
            index = _next_line(source, index)
        result[key] = value
    return result


def _next_line(source: str, index: int) -> int:
    while index < len(source) and source[index] not in "\r\n":
        index += 1
    while index < len(source) and source[index] in "\r\n":
        index += 1
    return index


def _cached(
    slot: tuple[str, ...],
    loader: Callable[[str | None], object],
    context: str | None,
):
    active = str(Path.cwd().resolve())
    resolved = str(Path(_context(context) or active).resolve())
    key = (*slot, active, resolved)
    if key in _CACHE:
        return _CACHE[key]
    value = loader(resolved)
    _CACHE[key] = value
    return value


def _context(value: object) -> str | None:
    resolved = _trim_to_none(value)
    return None if resolved == "." else resolved


def _sequence(value: object) -> builtins.list:
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    if isinstance(value, Sequence):
        return builtins.list(value)
    return [value]


def _join(*parts: str) -> str:
    return "_".join(part.strip() for part in parts if part.strip())


def _trim_to_none(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    resolved = value.strip()
    return resolved or None


def _to_boolean(value: object) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "t", "on", "1", "yes", "y"}:
            return True
        if normalized in {"false", "f", "off", "0", "no", "n"}:
            return False
    elif isinstance(value, (int, float)) and not isinstance(value, bool):
        if value == 1:
            return True
        if value == 0:
            return False
    return None


def _to_number(value: object) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        return number if math.isfinite(number) else None
    if not isinstance(value, str):
        value = str(value)
    text_value = value.strip()
    if text_value[:1] in {"+", "-"}:
        text_value = text_value[0] + text_value[1:].lstrip()
    text_value = re.sub(r"(?<=\d)\s+|,", "", text_value)
    match = _NUMBER_PATTERN.fullmatch(text_value)
    if match is None:
        return None
    number = float(match.group(1))
    if match.group(2):
        number /= 100
    return number if math.isfinite(number) else None


def _to_positive_number(value: object) -> float | None:
    parsed = _to_number(value)
    return parsed if parsed is not None and parsed > 0 else None


def _parse_list(
    raw: str | Sequence[str] | None,
    transform: Callable[[str], str] | None,
) -> builtins.list[str]:
    normalize = transform or str.strip
    entries = re.split(r"[\s,]+", raw) if isinstance(raw, str) else raw or ()
    result: builtins.list[str] = []
    for entry in entries:
        normalized = normalize(entry)
        if normalized and normalized not in result:
            result.append(normalized)
    return result


def _distinct(values: Sequence[str]) -> builtins.list[str]:
    return builtins.list(dict.fromkeys(values))


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


bundleFile = bundle_file
clearCache = clear_cache
isDatabricksAppEnv = is_databricks_app_env
positiveInt = positive_int
positiveNumber = positive_number

__all__ = [
    "ENV_ONLY",
    "MAX_TCP_PORT",
    "ConfigFile",
    "ConfigKey",
    "ConfigOptions",
    "ConfigSource",
    "boolean",
    "bundleFile",
    "bundle_file",
    "clearCache",
    "clear_cache",
    "isDatabricksAppEnv",
    "is_databricks_app_env",
    "list",
    "name",
    "positiveInt",
    "positiveNumber",
    "positive_int",
    "positive_number",
    "string",
    "text",
]
