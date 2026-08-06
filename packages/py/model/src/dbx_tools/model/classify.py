from __future__ import annotations

import math
import re
from collections.abc import Iterable

from .models import EndpointCapabilities, ModelClass, ServingEndpointSummary
from .reasoning import reasoning_efforts_by_family

CHAT_TASK = "llm/v1/chat"
EMBEDDING_TASK = "llm/v1/embeddings"


def supports_tools_by_family(name: str) -> bool:
    normalized = name.lower()
    if "gemini" in normalized or "gpt-oss" in normalized:
        return False
    return any(family in normalized for family in ("claude", "gpt", "qwen", "glm", "llama"))


def endpoint_capabilities(
    endpoint: ServingEndpointSummary | dict[str, object],
) -> EndpointCapabilities:
    summary = _summary(endpoint)
    embedding = summary.task == EMBEDDING_TASK or summary.model_class == ModelClass.EMBEDDING
    chat = not embedding and (summary.task == CHAT_TASK or summary.model_class is not None)
    tools = chat and (
        summary.supports_tools
        if summary.supports_tools is not None
        else supports_tools_by_family(summary.name)
    )
    reasoning_efforts = summary.reasoning_efforts or reasoning_efforts_by_family(summary.name)
    return EndpointCapabilities(
        chat=chat,
        embedding=embedding,
        tools=tools,
        reasoningEfforts=reasoning_efforts,
    )


def version_tuple(name: str) -> list[int]:
    match = re.search(r"\d", name)
    if match is None:
        return [0, 0, 0]
    numbers = []
    for chunk in re.split(r"[^a-z0-9]+", name[match.start() :], flags=re.IGNORECASE):
        digits = re.match(r"^\d+", chunk)
        if digits:
            numbers.append(int(digits.group(0)))
    return (numbers + [0, 0, 0])[:3]


def classify_by_family(name: str) -> dict[str, object] | None:
    normalized = name.lower()

    def result(model_class: ModelClass) -> dict[str, object]:
        major, minor, patch = version_tuple(normalized)
        return {"class": model_class.value, "rank": major * 1_000_000 + minor * 1_000 + patch}

    if "opus" in normalized:
        return result(ModelClass.CHAT_THINKING)
    if "sonnet" in normalized:
        return result(ModelClass.CHAT_BALANCED)
    if "haiku" in normalized:
        return result(ModelClass.CHAT_FAST)
    if "gpt-oss" in normalized:
        return result(ModelClass.CHAT_BALANCED if "120b" in normalized else ModelClass.CHAT_FAST)
    if "gpt" in normalized:
        if "pro" in normalized:
            return result(ModelClass.CHAT_THINKING)
        if "mini" in normalized or "nano" in normalized:
            return result(ModelClass.CHAT_FAST)
        return result(ModelClass.CHAT_BALANCED)
    if "gemini" in normalized:
        if "flash-lite" in normalized:
            return result(ModelClass.CHAT_FAST)
        if "pro" in normalized:
            return result(ModelClass.CHAT_THINKING)
        return result(ModelClass.CHAT_BALANCED)
    if "gemma" in normalized:
        return result(ModelClass.CHAT_FAST)
    if "llama" in normalized:
        if "maverick" in normalized or "405b" in normalized:
            return result(ModelClass.CHAT_THINKING)
        if "70b" in normalized:
            return result(ModelClass.CHAT_BALANCED)
        if "8b" in normalized or "1b" in normalized:
            return result(ModelClass.CHAT_FAST)
        return result(ModelClass.CHAT_BALANCED)
    if "qwen" in normalized:
        return result(ModelClass.CHAT_BALANCED)
    return None


def classify_endpoints(
    endpoints: Iterable[ServingEndpointSummary | dict[str, object]],
) -> dict[str, list[dict[str, object]]]:
    summaries = [_summary(endpoint) for endpoint in endpoints]
    chat = [endpoint for endpoint in summaries if endpoint.task == CHAT_TASK]
    qualities = sorted(
        endpoint.profile.quality
        for endpoint in chat
        if endpoint.profile is not None
        and endpoint.profile.quality is not None
        and math.isfinite(endpoint.profile.quality)
    )
    low = _quantile(qualities, 1 / 3)
    high = _quantile(qualities, 2 / 3)
    buckets: dict[ModelClass, list[tuple[tuple[object, ...], ServingEndpointSummary]]] = {
        model_class: [] for model_class in ModelClass
    }

    for endpoint in chat:
        quality = endpoint.profile.quality if endpoint.profile else None
        if quality is not None and math.isfinite(quality):
            model_class = (
                ModelClass.CHAT_THINKING
                if quality >= high
                else ModelClass.CHAT_FAST
                if quality <= low
                else ModelClass.CHAT_BALANCED
            )
            cost = (
                endpoint.profile.cost
                if endpoint.profile and endpoint.profile.cost is not None
                else math.inf
            )
            speed = (
                endpoint.profile.speed
                if endpoint.profile and endpoint.profile.speed is not None
                else 0
            )
            key = (0, -quality, cost, -speed, *[-part for part in version_tuple(endpoint.name)])
        else:
            family = classify_by_family(endpoint.name)
            if family is None:
                continue
            model_class = ModelClass(str(family["class"]))
            key = (
                1,
                -int(family["rank"]),
                math.inf,
                0,
                *[-part for part in version_tuple(endpoint.name)],
            )
        buckets[model_class].append((key, endpoint))

    embeddings = [endpoint for endpoint in summaries if endpoint.task == EMBEDDING_TASK]
    return {
        ModelClass.CHAT_THINKING.value: _dump_sorted(buckets[ModelClass.CHAT_THINKING]),
        ModelClass.CHAT_BALANCED.value: _dump_sorted(buckets[ModelClass.CHAT_BALANCED]),
        ModelClass.CHAT_FAST.value: _dump_sorted(buckets[ModelClass.CHAT_FAST]),
        ModelClass.EMBEDDING.value: [endpoint.as_dict() for endpoint in embeddings],
    }


def classified_summaries(
    endpoints: Iterable[ServingEndpointSummary | dict[str, object]],
) -> dict[ModelClass, list[ServingEndpointSummary]]:
    return {
        ModelClass(key): [ServingEndpointSummary.model_validate(value) for value in values]
        for key, values in classify_endpoints(endpoints).items()
    }


def _summary(value: ServingEndpointSummary | dict[str, object]) -> ServingEndpointSummary:
    return (
        value
        if isinstance(value, ServingEndpointSummary)
        else ServingEndpointSummary.model_validate(value)
    )


def _quantile(values: list[float], probability: float) -> float:
    if not values:
        return math.nan
    index = (len(values) - 1) * probability
    lower = math.floor(index)
    upper = math.ceil(index)
    if lower == upper:
        return values[lower]
    return values[lower] + (values[upper] - values[lower]) * (index - lower)


def _dump_sorted(
    values: list[tuple[tuple[object, ...], ServingEndpointSummary]],
) -> list[dict[str, object]]:
    return [endpoint.as_dict() for _, endpoint in sorted(values, key=lambda value: value[0])]
