from __future__ import annotations

import math
import re
from collections.abc import Iterable, Mapping
from typing import Any, Protocol

from .classes import MODEL_CLASS_ORDER
from .classify import classified_summaries, supports_tools_by_family
from .models import ModelProfile, ServingEndpointSummary
from .reasoning import reasoning_efforts_for_names


class ServingEndpointsApi(Protocol):
    def list(self) -> Iterable[object]: ...


class WorkspaceClientLike(Protocol):
    serving_endpoints: ServingEndpointsApi


def list_serving_endpoints(client: WorkspaceClientLike) -> list[ServingEndpointSummary]:
    summaries = list_serving_endpoints_uncached(client)
    buckets = classified_summaries(summaries)
    classes = {
        endpoint.name: model_class
        for model_class in MODEL_CLASS_ORDER
        for endpoint in buckets[model_class]
    }
    for summary in summaries:
        summary.model_class = classes.get(summary.name)
    return summaries


def list_serving_endpoints_uncached(client: WorkspaceClientLike) -> list[ServingEndpointSummary]:
    summaries = []
    for endpoint in client.serving_endpoints.list():
        name = _value(endpoint, "name")
        if not isinstance(name, str) or not name:
            continue
        summaries.append(
            ServingEndpointSummary(
                name=name,
                displayName=to_model_display_name(name, _provided_display_name(endpoint)),
                task=_string(_value(endpoint, "task")),
                state=_string(_value(_value(endpoint, "state"), "ready")),
                description=_string(_value(endpoint, "description")),
                supportsTools=supports_tools_by_family(name),
                profile=_extract_profile(endpoint),
                reasoningEfforts=reasoning_efforts_for_names(_model_identities(endpoint, name)),
            )
        )
    return summaries


def to_model_display_name(name: str, provided: str | None = None) -> str:
    if provided is not None and provided.strip():
        return provided.strip()
    segments = [segment for segment in re.split(r"[-_.\s/]+", name) if segment]
    start = 0
    while start < len(segments) and segments[start].lower() in {"databricks", "system", "dbx"}:
        if (
            segments[start].lower() == "system"
            and start + 1 < len(segments)
            and segments[start + 1].lower() == "ai"
        ):
            start += 1
        start += 1
    source = segments[start:] or segments
    acronyms = {"gpt", "gte", "bge", "dbrx", "oss", "llm", "moe", "ai"}
    pieces = []
    numeric = []
    for segment in source:
        if segment.isdigit():
            numeric.append(segment)
            continue
        if numeric:
            pieces.append(".".join(numeric))
            numeric = []
        size = re.fullmatch(r"(\d+)([bmk])", segment, flags=re.IGNORECASE)
        if size:
            pieces.append(f"{size.group(1)}{size.group(2).upper()}")
        else:
            lower = segment.lower()
            pieces.append(lower.upper() if lower in acronyms else lower.capitalize())
    if numeric:
        pieces.append(".".join(numeric))
    return " ".join(pieces) or name.strip()


def _extract_profile(endpoint: object) -> ModelProfile | None:
    config = _value(endpoint, "config")
    entities = _value(config, "served_entities") or []
    for entity in entities:
        foundation = _value(entity, "foundation_model")
        raw = _value(foundation, "ai_gateway_model_profile")
        values = {
            key: value
            for key in ("quality", "speed", "cost")
            if isinstance((value := _value(raw, key)), (int, float)) and math.isfinite(value)
        }
        if values:
            return ModelProfile.model_validate(values)
    return None


def _provided_display_name(endpoint: object) -> str | None:
    for tag in _value(endpoint, "tags") or []:
        if _value(tag, "key") in {"display_name", "displayName", "name"}:
            value = _string(_value(tag, "value"))
            if value and value.strip():
                return value.strip()
    config = _value(endpoint, "config")
    for entity in _value(config, "served_entities") or []:
        value = _string(_value(_value(entity, "external_model"), "name"))
        if value and value.strip():
            return value.strip()
    return None


def _model_identities(endpoint: object, endpoint_name: str) -> list[str]:
    identities = [endpoint_name]
    config = _value(endpoint, "config")
    for entity in _value(config, "served_entities") or []:
        for value in (
            _value(entity, "entity_name"),
            _value(_value(entity, "foundation_model"), "name"),
            _value(_value(entity, "external_model"), "name"),
        ):
            if isinstance(value, str) and value:
                identities.append(value)
    return identities


def _value(value: object, key: str) -> Any:
    if isinstance(value, Mapping):
        return value.get(key)
    return getattr(value, key, None)


def _string(value: object) -> str | None:
    return None if value is None else str(value)
