from __future__ import annotations

import re
from collections.abc import Iterable, Sequence
from difflib import SequenceMatcher

from .classes import CHAT_CLASS_ORDER, MODEL_CLASS_ORDER, classes_at_or_below
from .classify import classified_summaries, endpoint_capabilities, version_tuple
from .fallback import FALLBACK_MODEL_IDS, models_for_class
from .models import (
    ModelClass,
    ModelQuery,
    RankedModel,
    ResolvedModel,
    ResolvedModelSelection,
    ServingEndpointSummary,
)

DEFAULT_FUZZY_THRESHOLD = 0.4


def search_serving_endpoints(
    input_value: str,
    endpoints: Iterable[ServingEndpointSummary | dict[str, object]],
    threshold: float = DEFAULT_FUZZY_THRESHOLD,
) -> list[dict[str, object]]:
    summaries = [_summary(endpoint) for endpoint in endpoints]
    for endpoint in summaries:
        if endpoint.name == input_value:
            return [{"endpoint": endpoint.as_dict(), "score": 0}]
    tokens = re.findall(r"[a-zA-Z0-9]+", input_value.lower())
    if not tokens:
        return []
    matches = []
    for endpoint in summaries:
        name = endpoint.name.lower()
        token_scores = [_token_distance(token, name) for token in tokens]
        score = sum(token_scores) / len(token_scores)
        if score <= threshold:
            matches.append({"endpoint": endpoint.as_dict(), "score": score})
    return sorted(matches, key=lambda match: (float(match["score"]), match["endpoint"]["name"]))


def resolve_model_id(
    input_value: str,
    endpoints: Iterable[ServingEndpointSummary | dict[str, object]],
    *,
    threshold: float = DEFAULT_FUZZY_THRESHOLD,
    requires_tools: bool = False,
) -> ResolvedModel:
    candidates = [
        _summary(endpoint)
        for endpoint in endpoints
        if not requires_tools or endpoint_capabilities(_summary(endpoint)).tools
    ]
    matches = search_serving_endpoints(input_value, candidates, threshold)
    if not matches:
        return ResolvedModel(modelId=input_value, matched=False)
    top = matches[0]
    return ResolvedModel(
        modelId=str(top["endpoint"]["name"]), matched=True, score=float(top["score"])
    )


def rank_models(
    endpoints: Iterable[ServingEndpointSummary | dict[str, object]],
    query: ModelQuery | dict[str, object] | None = None,
) -> list[dict[str, object]]:
    summaries = [_summary(endpoint) for endpoint in endpoints]
    request = query if isinstance(query, ModelQuery) else ModelQuery.model_validate(query or {})
    classified = classified_summaries(summaries)
    eligible = (
        classes_at_or_below(request.model_class)
        if request.model_class is not None
        else list(CHAT_CLASS_ORDER)
    )
    candidates: list[RankedModel] = []
    for model_class in eligible:
        for endpoint in classified[model_class]:
            if request.requires_tools and not endpoint_capabilities(endpoint).tools:
                continue
            candidates.append(RankedModel(endpoint=endpoint, modelClass=model_class))

    search = request.search.strip() if request.search else ""
    if search:
        gpt_family_search = search.lower() == "gpt"
        scores = {
            str(match["endpoint"]["name"]): float(match["score"])
            for match in search_serving_endpoints(
                search,
                [candidate.endpoint for candidate in candidates],
                request.threshold if request.threshold is not None else DEFAULT_FUZZY_THRESHOLD,
            )
        }
        candidates = [candidate for candidate in candidates if candidate.endpoint.name in scores]
        if gpt_family_search:
            candidates = [
                candidate
                for candidate in candidates
                if not re.search(
                    r"(?:^|[-_.])gpt[-_.]?oss(?:[-_.]|$)",
                    candidate.endpoint.name,
                    re.IGNORECASE,
                )
            ]
        for candidate in candidates:
            candidate.score = scores[candidate.endpoint.name]
        candidates.sort(
            key=lambda candidate: (
                round((candidate.score or 0) * 1000),
                *(
                    [-part for part in version_tuple(candidate.endpoint.name)]
                    if gpt_family_search
                    else []
                ),
                MODEL_CLASS_ORDER.index(candidate.model_class),
            )
        )
    if request.limit is not None:
        candidates = candidates[: max(0, request.limit)]
    return [candidate.as_dict() for candidate in candidates]


def rank_model_id(
    endpoints: Iterable[ServingEndpointSummary | dict[str, object]],
    search: str,
    *,
    threshold: float = DEFAULT_FUZZY_THRESHOLD,
    requires_tools: bool = False,
) -> ResolvedModel:
    ranked = rank_models(
        endpoints,
        ModelQuery(
            search=search,
            limit=1,
            threshold=threshold,
            requiresTools=requires_tools,
        ),
    )
    if not ranked:
        return ResolvedModel(modelId=search, matched=False)
    return ResolvedModel(
        modelId=str(ranked[0]["endpoint"]["name"]),
        matched=True,
        score=float(ranked[0]["score"]),
    )


def resolve_model(
    endpoints: Iterable[ServingEndpointSummary | dict[str, object]],
    *,
    explicit: str | None = None,
    fuzzy: bool = True,
    threshold: float = DEFAULT_FUZZY_THRESHOLD,
    requires_tools: bool = False,
    model_class: ModelClass | None = None,
    fallbacks: Sequence[str] = (),
) -> ResolvedModelSelection:
    summaries = [_summary(endpoint) for endpoint in endpoints]
    if explicit is not None:
        if not fuzzy:
            if requires_tools:
                _assert_tool_support(summaries, explicit)
            return ResolvedModelSelection(modelId=explicit, source="explicit")
        ranked = rank_models(
            summaries,
            ModelQuery(
                search=explicit,
                modelClass=model_class,
                requiresTools=requires_tools,
                threshold=threshold,
                limit=1,
            ),
        )
        if requires_tools and not ranked:
            raise ValueError(f'No tool-capable model matches "{explicit}"')
        model_id = str(ranked[0]["endpoint"]["name"]) if ranked else explicit
        return ResolvedModelSelection(modelId=model_id, source="fuzzy-match")

    if model_class is None and fallbacks:
        present = {
            endpoint.name
            for endpoint in summaries
            if not requires_tools or endpoint_capabilities(endpoint).tools
        }
        for fallback in fallbacks:
            if fallback in present:
                return ResolvedModelSelection(modelId=fallback, source="fallback")

    source = "class" if model_class is not None else "fallback"
    ranked = rank_models(
        summaries,
        ModelQuery(modelClass=model_class, requiresTools=requires_tools, limit=1),
    )
    if ranked:
        return ResolvedModelSelection(modelId=str(ranked[0]["endpoint"]["name"]), source=source)

    floor_source = models_for_class(model_class) if model_class is not None else list(fallbacks)
    floor = list(dict.fromkeys([*floor_source, *FALLBACK_MODEL_IDS]))
    if requires_tools:
        available = {
            endpoint.name for endpoint in summaries if endpoint_capabilities(endpoint).tools
        }
        selected = next((model_id for model_id in floor if model_id in available), None)
        if selected is None:
            raise ValueError("No tool-capable model is available")
        return ResolvedModelSelection(modelId=selected, source=source)
    present = {endpoint.name for endpoint in summaries}
    selected = next((model_id for model_id in floor if model_id in present), floor[0])
    return ResolvedModelSelection(modelId=selected, source=source)


def _token_distance(token: str, name: str) -> float:
    if token in name:
        return 0.0
    segments = re.findall(r"[a-z0-9]+", name)
    similarity = max(
        (SequenceMatcher(None, token, segment).ratio() for segment in segments), default=0
    )
    return 1 - similarity


def _assert_tool_support(endpoints: list[ServingEndpointSummary], model_id: str) -> None:
    endpoint = next((candidate for candidate in endpoints if candidate.name == model_id), None)
    if endpoint is None or not endpoint_capabilities(endpoint).tools:
        raise ValueError(f'Model "{model_id}" does not support function tools')


def _summary(value: ServingEndpointSummary | dict[str, object]) -> ServingEndpointSummary:
    return (
        value
        if isinstance(value, ServingEndpointSummary)
        else ServingEndpointSummary.model_validate(value)
    )
