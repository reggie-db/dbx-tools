from __future__ import annotations

from .classify import classify_by_family
from .models import ModelClass

_FALLBACK_MODEL_NAMES = (
    "databricks-claude-opus-4-8",
    "databricks-gpt-5-5-pro",
    "databricks-gemini-3-1-pro",
    "databricks-claude-sonnet-4-6",
    "databricks-gpt-5-5",
    "databricks-meta-llama-3-3-70b-instruct",
    "databricks-claude-haiku-4-5",
    "databricks-gpt-5-nano",
    "databricks-meta-llama-3-1-8b-instruct",
)


def models_for_class(model_class: ModelClass) -> list[str]:
    classified = []
    for name in _FALLBACK_MODEL_NAMES:
        family = classify_by_family(name)
        if family is not None and family["class"] == model_class.value:
            classified.append((int(family["rank"]), name))
    return [name for _, name in sorted(classified, reverse=True)]


def model_for_class(model_class: ModelClass) -> str:
    return models_for_class(model_class)[0]


FALLBACK_MODEL_IDS = tuple(
    model
    for model_class in (
        ModelClass.CHAT_THINKING,
        ModelClass.CHAT_BALANCED,
        ModelClass.CHAT_FAST,
    )
    for model in models_for_class(model_class)
)
