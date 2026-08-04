from __future__ import annotations

from .models import ModelClass

CHAT_CLASS_ORDER = (
    ModelClass.CHAT_THINKING,
    ModelClass.CHAT_BALANCED,
    ModelClass.CHAT_FAST,
)
MODEL_CLASS_ORDER = (*CHAT_CLASS_ORDER, ModelClass.EMBEDDING)


def is_chat_class(model_class: ModelClass) -> bool:
    return model_class in CHAT_CLASS_ORDER


def parse_model_class(value: object) -> ModelClass | None:
    try:
        return ModelClass(value)
    except (TypeError, ValueError):
        try:
            return ModelClass(f"chat-{value}")
        except (TypeError, ValueError):
            return None


def classes_at_or_below(model_class: ModelClass) -> list[ModelClass]:
    if model_class == ModelClass.EMBEDDING:
        return [ModelClass.EMBEDDING]
    try:
        return list(CHAT_CLASS_ORDER[CHAT_CLASS_ORDER.index(model_class) :])
    except ValueError:
        return list(CHAT_CLASS_ORDER)
