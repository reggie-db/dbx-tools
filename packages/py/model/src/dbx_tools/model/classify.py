from __future__ import annotations

import math
from collections.abc import Iterable

from .models import (
    EndpointCapabilities,
    ModelClass,
    ModelFamily,
    ServingEndpointSummary,
    parse_model_name,
    version_tuple,
)
from .reasoning import reasoning_efforts_by_family

CHAT_TASK = "llm/v1/chat"
EMBEDDING_TASK = "llm/v1/embeddings"


def supports_tools_by_family(name: str) -> bool:
    parsed = parse_model_name(name)
    if parsed is None:
        return False
    if parsed.family == ModelFamily.GEMINI:
        return False
    if parsed.family == ModelFamily.GPT and "oss" in parsed.model:
        return False
    return parsed.family in {
        ModelFamily.CLAUDE,
        ModelFamily.GLM,
        ModelFamily.GPT,
        ModelFamily.LLAMA,
        ModelFamily.QWEN,
    }


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


def classify_by_family(name: str) -> dict[str, object] | None:
    parsed = parse_model_name(name)
    if parsed is None:
        return None
    model = set(parsed.model)

    def result(model_class: ModelClass) -> dict[str, object]:
        major, minor, patch = version_tuple(name)
        return {"class": model_class.value, "rank": major * 1_000_000 + minor * 1_000 + patch}

    if parsed.family == ModelFamily.CLAUDE and "opus" in model:
        return result(ModelClass.CHAT_THINKING)
    if parsed.family == ModelFamily.CLAUDE and "sonnet" in model:
        return result(ModelClass.CHAT_BALANCED)
    if parsed.family == ModelFamily.CLAUDE and "haiku" in model:
        return result(ModelClass.CHAT_FAST)
    if parsed.family == ModelFamily.GPT and "oss" in model:
        return result(ModelClass.CHAT_BALANCED if "120b" in model else ModelClass.CHAT_FAST)
    if parsed.family == ModelFamily.GPT:
        if "pro" in model:
            return result(ModelClass.CHAT_THINKING)
        if "mini" in model or "nano" in model:
            return result(ModelClass.CHAT_FAST)
        return result(ModelClass.CHAT_BALANCED)
    if parsed.family == ModelFamily.GEMINI:
        if {"flash", "lite"} <= model:
            return result(ModelClass.CHAT_FAST)
        if "pro" in model:
            return result(ModelClass.CHAT_THINKING)
        return result(ModelClass.CHAT_BALANCED)
    if parsed.family == ModelFamily.GEMMA:
        return result(ModelClass.CHAT_FAST)
    if parsed.family == ModelFamily.LLAMA:
        if "maverick" in model or "405b" in model:
            return result(ModelClass.CHAT_THINKING)
        if "70b" in model:
            return result(ModelClass.CHAT_BALANCED)
        if "8b" in model or "1b" in model:
            return result(ModelClass.CHAT_FAST)
        return result(ModelClass.CHAT_BALANCED)
    if parsed.family == ModelFamily.QWEN:
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
