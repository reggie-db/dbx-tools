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
from typing import Literal, TypedDict, TypeVar, cast
from urllib.parse import urlparse

ConfigKey = str | Sequence[str]
ConfigData = Mapping[str, object]
ConfigSource = Literal["config", "env", "dotenv", "bundle", "app"]


class ConfigOptions(TypedDict, total=False):
    scope: str | Sequence[str]
    prefix: str | Sequence[str]
    cwd: str
    data: ConfigData | Sequence[ConfigData]
    bundleData: ConfigFile | Mapping[str, object]
    appData: ConfigFile | Mapping[str, object]
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
DEFAULT_SOURCES: tuple[ConfigSource, ...] = ("config", "env", "dotenv", "bundle", "app")
BUNDLE_FILE_NAMES = ("databricks.yml", "databricks.yaml")
APP_FILE_NAMES = ("app.yaml", "app.yml")
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
CONFIG_APP_KEY = "DBX_TOOLS_CONFIG_APP"
ENV_ONLY: ConfigOptions = {"scope": (), "sources": "env"}

_RecordT = TypeVar("_RecordT", bound=Mapping[str, object])
_FILE_DATA_CACHE: dict[str, Mapping[str, object] | None] = {}
_CONFIG_FILE_CACHE: dict[str, str | None] = {}
_NUMBER_PATTERN = re.compile(
    r"^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(%)?$",
    re.IGNORECASE,
)
_INTERPOLATION_PATTERN = re.compile(r"\$\{[^}]+\}")
_ENV_NAME_PATTERN = re.compile(r"[A-Za-z0-9_.-]+")
_YAML_NUMBER_PATTERN = re.compile(
    r"^[+-]?(?:0|[1-9][0-9_]*)(?:\.[0-9_]*)?(?:e[+-]?[0-9]+)?$",
    re.IGNORECASE,
)


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


def environment_keys(name: str) -> list[str]:
    trimmed = name.strip()
    if not trimmed:
        return []
    tokenized = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", trimmed)
    tokenized = re.sub(r"[^A-Za-z0-9]+", "_", tokenized).strip("_").upper()
    return _distinct([trimmed, trimmed.upper(), tokenized])


def resolve_value(name: str, options: ConfigOptions | None = None) -> str | None:
    return text(environment_keys(name), options)


def get_bundle_path(data: Mapping[str, object], path: str) -> str | None:
    parts = [part for part in path.split(".") if part]
    if not parts:
        return None
    current: object = data
    for index, part in enumerate(parts):
        if not isinstance(current, Mapping):
            return None
        value = current.get(part)
        if index == len(parts) - 1:
            direct = _resolved_string(value)
            if direct is not None:
                return direct
            return _resolved_string(value.get("value")) if isinstance(value, Mapping) else None
        current = value
    return None


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
    return _load_bundle_file(
        _resolve_working_directory(cwd),
        _trim_to_none(os.environ.get("DATABRICKS_CONFIG_PROFILE")),
    )


def app_file(cwd: str | None = None) -> ConfigFile | None:
    if not _file_source_enabled(CONFIG_APP_KEY):
        return None
    return _load_app_file(_resolve_working_directory(cwd))


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
    sources = _config_sources(options)
    for source in sources:
        if source not in DEFAULT_SOURCES:
            continue
        for values in _read(source, options):
            for key in candidates:
                value = _config_value(values.get(key))
                if value is not None:
                    yield _ConfigValue(key=key, source=source, value=value)


def _config_sources(options: ConfigOptions) -> list[ConfigSource]:
    sources = _distinct(_sequence(options.get("sources", DEFAULT_SOURCES)))
    if "data" in options and "sources" in options and "config" not in sources:
        sources.append("config")
    return cast(builtins.list[ConfigSource], sources)


def _config_value(value: object) -> str | None:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        for entry in value:
            resolved = _trim_to_none(entry)
            if resolved is not None:
                return resolved
        return None
    return _trim_to_none(value)


def _read(source: ConfigSource, options: ConfigOptions) -> Iterator[Mapping[str, object]]:
    if source == "config":
        for data in _sequence(options.get("data")):
            if isinstance(data, Mapping):
                yield data
    elif source == "env":
        yield os.environ
    elif source == "dotenv":
        yield _dotenv(options.get("cwd"))
    elif source == "bundle":
        data = _source_data(options.get("bundleData"))
        if data is None:
            data = bundle_file(options.get("cwd"))
            data = data.data if data is not None else None
        if data is not None:
            yield flatten_bundle_env(data)
    else:
        data = _source_data(options.get("appData"))
        if data is None:
            data = app_file(options.get("cwd"))
            data = data.data if data is not None else None
        if data is not None:
            yield flatten_app_env(data)


def _source_data(source: object) -> Mapping[str, object] | None:
    if isinstance(source, ConfigFile):
        return source.data
    return source if isinstance(source, Mapping) else None


def _dotenv(cwd: str | None) -> dict[str, str]:
    if not _file_source_enabled(CONFIG_DOTENV_KEY):
        return {}
    return _load_dotenv(
        _resolve_working_directory(cwd),
        _node_env_names(os.environ.get("NODE_ENV")),
    )


def _resolve_working_directory(cwd: str | None = None) -> str:
    value = cwd.strip() if isinstance(cwd, str) else ""
    return str(Path(value or Path.cwd()).resolve())


def _cached_record(key: str, loader: Callable[[], _RecordT | None]) -> _RecordT | None:
    if key in _FILE_DATA_CACHE:
        return cast(_RecordT | None, _FILE_DATA_CACHE[key])
    value = loader()
    _FILE_DATA_CACHE[key] = value
    return value


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
    key = json.dumps([str(start), *names])
    if key in _CONFIG_FILE_CACHE:
        return _CONFIG_FILE_CACHE[key]
    root = _project_root(start)
    boundary = root if root is not None and _is_relative_to(start, root) else None
    directory = start
    while True:
        for file_name in names:
            candidate = directory / file_name
            try:
                if candidate.is_file():
                    path = str(candidate)
                    _CONFIG_FILE_CACHE[key] = path
                    return path
            except OSError:
                pass
        if boundary is None or directory == boundary:
            _CONFIG_FILE_CACHE[key] = None
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
    return (
        _cached_record(
            json.dumps(["dotenv", path]),
            lambda: _read_dotenv_file(path),
        )
        or {}
    )


def _read_dotenv_file(path: str) -> dict[str, str]:
    try:
        return _parse_env(Path(path).read_text(encoding="utf-8"))
    except (OSError, UnicodeError):
        return {}


def _load_bundle_file(cwd: str | None, profile: str | None) -> ConfigFile | None:
    path = _find_config_file(cwd or ".", BUNDLE_FILE_NAMES)
    if path is None:
        return None
    data = _cached_record(
        json.dumps(["bundle", path, profile]),
        lambda: _validate_bundle(path, profile),
    )
    return None if data is None else ConfigFile(path=path, data=dict(data))


def _load_app_file(cwd: str | None) -> ConfigFile | None:
    path = _find_config_file(cwd or ".", APP_FILE_NAMES)
    if path is None:
        return None
    data = _cached_record(
        json.dumps(["app", path]),
        lambda: _read_app_file(path),
    )
    return None if data is None else ConfigFile(path=path, data=dict(data))


def _read_app_file(path: str) -> dict[str, object] | None:
    try:
        return _parse_app_yaml(Path(path).read_text(encoding="utf-8"))
    except (OSError, UnicodeError):
        return None


def _validate_bundle(path: str, profile: str | None) -> dict[str, object] | None:
    arguments = ["databricks", "bundle", "validate", "--output", "json"]
    if profile is not None:
        arguments.extend(["--profile", profile])
    try:
        result = subprocess.run(
            arguments,
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
    return data


def flatten_app_env(input: object) -> dict[str, str]:
    if not isinstance(input, Mapping):
        return {}
    entries = input.get("env")
    if not isinstance(entries, builtins.list):
        return {}
    result: dict[str, str] = {}
    resources = _named_resources(input.get("resources"))
    for entry in entries:
        if not isinstance(entry, Mapping):
            continue
        name = _resolved_string(entry.get("name"))
        value = _resolved_string(entry.get("value"))
        if name is None:
            continue
        if value is not None:
            result[name] = value
            continue
        reference = _resolved_string(entry.get("valueFrom"))
        resolved = _resource_value(resources.get(reference)) if reference else None
        if resolved is not None:
            result[name] = resolved
    return result


def _parse_app_yaml(source: str) -> dict[str, object] | None:
    lines = source.splitlines()
    env = _parse_yaml_record_list(lines, "env")
    resources = _parse_yaml_record_list(lines, "resources")
    if env is None and resources is None:
        return None
    result: dict[str, object] = {}
    if env is not None:
        result["env"] = env
    if resources is not None:
        result["resources"] = resources
    return result


def _parse_yaml_record_list(
    lines: Sequence[str],
    section: str,
) -> builtins.list[dict[str, object]] | None:
    entries: builtins.list[dict[str, object]] = []
    current: dict[str, object] | None = None
    section_indent: int | None = None
    item_indent: int | None = None
    nested_key: str | None = None
    nested_indent: int | None = None
    for raw_line in lines:
        line = raw_line.rstrip()
        stripped = line.lstrip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(line) - len(stripped)
        if section_indent is None:
            if indent == 0 and re.fullmatch(rf"{re.escape(section)}:\s*(?:#.*)?", stripped):
                section_indent = indent
            continue
        if indent <= section_indent:
            break
        item = stripped
        if item.startswith("-"):
            if current is not None:
                entries.append(current)
            current = {}
            item_indent = indent
            nested_key = None
            nested_indent = None
            item = item[1:].strip()
            if not item:
                continue
        if current is None or ":" not in item:
            continue
        key, raw_value = item.split(":", 1)
        key = key.strip()
        if not key:
            continue
        value = _parse_yaml_string(raw_value)
        if value is not None:
            if nested_key is not None and nested_indent is not None and indent > nested_indent:
                nested = current.get(nested_key)
                if isinstance(nested, dict):
                    nested[key] = value
            else:
                nested_key = None
                nested_indent = None
                current[key] = value
        elif not raw_value.strip() and item_indent is not None and indent > item_indent:
            current[key] = {}
            nested_key = key
            nested_indent = indent
    if current is not None:
        entries.append(current)
    return entries if section_indent is not None else None


def _parse_yaml_string(raw: str) -> str | None:
    value = raw.strip()
    if not value:
        return None
    if value.startswith('"'):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return None
        return parsed if isinstance(parsed, str) else None
    if value.startswith("'"):
        if len(value) < 2 or not value.endswith("'"):
            return None
        return value[1:-1].replace("''", "'")
    value = value.split(" #", 1)[0].strip()
    if not value or value[0] in "[{|>" or value[-1] in "]}":
        return None
    if value.lower() in {"null", "~", "true", "false", "yes", "no", "on", "off"}:
        return None
    if _YAML_NUMBER_PATTERN.fullmatch(value):
        return None
    return value


def flatten_bundle_env(input: object) -> dict[str, str]:
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
    resource_map = _named_resources(app.get("resources"))
    for entry in entries:
        if not isinstance(entry, Mapping):
            continue
        key = _resolved_string(entry.get("name"))
        value = _resolved_string(entry.get("value"))
        if key is None:
            continue
        if value is not None:
            result[key] = value
            continue
        reference = _resolved_string(entry.get("value_from"))
        resolved = _resource_value(resource_map.get(reference)) if reference else None
        if resolved is not None:
            result[key] = resolved
    return result


def _named_resources(input: object) -> dict[str, Mapping[object, object]]:
    if not isinstance(input, builtins.list):
        return {}
    result: dict[str, Mapping[object, object]] = {}
    for resource in input:
        if not isinstance(resource, Mapping):
            continue
        name = _resolved_string(resource.get("name"))
        if name is not None:
            result[name] = resource
    return result


def _resource_value(resource: Mapping[object, object] | None) -> str | None:
    for path in (
        ("sql_warehouse", "id"),
        ("genie_space", "space_id"),
        ("postgres", "endpoint"),
        ("postgres", "database"),
        ("postgres", "branch"),
    ):
        value: object = resource
        for part in path:
            value = value.get(part) if isinstance(value, Mapping) else None
        resolved = _resolved_string(value)
        if resolved is not None:
            return resolved
    return None


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
appFile = app_file
environmentKeys = environment_keys
flattenAppEnv = flatten_app_env
flattenBundleEnv = flatten_bundle_env
getBundlePath = get_bundle_path
isDatabricksAppEnv = is_databricks_app_env
positiveInt = positive_int
positiveNumber = positive_number
resolveValue = resolve_value

__all__ = [
    "ENV_ONLY",
    "MAX_TCP_PORT",
    "ConfigData",
    "ConfigFile",
    "ConfigKey",
    "ConfigOptions",
    "ConfigSource",
    "appFile",
    "app_file",
    "boolean",
    "bundleFile",
    "bundle_file",
    "environmentKeys",
    "environment_keys",
    "flattenAppEnv",
    "flattenBundleEnv",
    "flatten_app_env",
    "flatten_bundle_env",
    "getBundlePath",
    "get_bundle_path",
    "isDatabricksAppEnv",
    "is_databricks_app_env",
    "list",
    "name",
    "positiveInt",
    "positiveNumber",
    "positive_int",
    "positive_number",
    "resolveValue",
    "resolve_value",
    "string",
    "text",
]
