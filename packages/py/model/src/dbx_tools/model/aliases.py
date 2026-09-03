"""Plain standard aliases generated from parsed model identities."""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass

from .models import ModelFamily, ParsedModelName, model_search_query, parse_model_name


@dataclass(frozen=True)
class ModelAliasIndex:
    """Unique aliases and their provider-neutral fuzzy search queries."""

    aliases_by_model: Mapping[str, tuple[str, ...]]
    searches_by_alias: Mapping[str, str]

    def aliases_for(self, model: str) -> tuple[str, ...]:
        """Return standard aliases generated for a model."""
        return self.aliases_by_model.get(model, ())

    def search_for(self, alias: str) -> str | None:
        """Return the fuzzy search query registered for an alias."""
        return self.searches_by_alias.get(_normalize_alias(alias))


def generate_model_aliases(value: str | ParsedModelName) -> tuple[str, ...]:
    """Generate every recognized standard alias for one model."""
    parsed = value if isinstance(value, ParsedModelName) else parse_model_name(value)
    if parsed is None:
        return ()
    aliases = [alias for generator in ALIAS_GENERATORS if (alias := generator(parsed)) is not None]
    return tuple(dict.fromkeys(aliases))


def build_model_alias_index(models: Iterable[str]) -> ModelAliasIndex:
    """Build collision-safe aliases and fuzzy queries for a model catalogue."""
    model_names = tuple(dict.fromkeys(models))
    exact_models = {_normalize_alias(model) for model in model_names}
    candidates: dict[str, list[tuple[str, str, str]]] = {}
    for model in model_names:
        parsed = parse_model_name(model)
        if parsed is None or (search := model_search_query(parsed)) is None:
            continue
        for alias in generate_model_aliases(parsed):
            normalized = _normalize_alias(alias)
            if not normalized or normalized in exact_models:
                continue
            candidates.setdefault(normalized, []).append((alias, model, search))

    aliases_by_model: dict[str, list[str]] = {model: [] for model in model_names}
    searches_by_alias: dict[str, str] = {}
    for normalized, values in candidates.items():
        if len({model for _, model, _ in values}) != 1:
            continue
        alias, model, search = values[0]
        aliases_by_model[model].append(alias)
        searches_by_alias[normalized] = search
    return ModelAliasIndex(
        aliases_by_model={
            model: tuple(aliases) for model, aliases in aliases_by_model.items() if aliases
        },
        searches_by_alias=searches_by_alias,
    )


def _openai_alias(parsed: ParsedModelName) -> str | None:
    if parsed.family != ModelFamily.GPT:
        return None
    return _dotted_alias("gpt", parsed)


def _anthropic_alias(parsed: ParsedModelName) -> str | None:
    if parsed.family != ModelFamily.CLAUDE:
        return None
    variant = parsed.model[:1]
    suffix = parsed.model[1:]
    return _joined(
        "claude",
        *variant,
        *(str(part) for part in parsed.version),
        *suffix,
    )


def _gemini_alias(parsed: ParsedModelName) -> str | None:
    if parsed.family != ModelFamily.GEMINI:
        return None
    return _dotted_alias("gemini", parsed)


def _qwen_alias(parsed: ParsedModelName) -> str | None:
    if parsed.family != ModelFamily.QWEN or not parsed.version:
        return None
    suffix = f"-{'-'.join(parsed.model)}" if parsed.model else ""
    return f"qwen{_dotted_version(parsed.version)}{suffix}"


def _llama_alias(parsed: ParsedModelName) -> str | None:
    if parsed.family != ModelFamily.LLAMA or not parsed.version:
        return None
    return _dotted_alias("llama", parsed)


def _gemma_alias(parsed: ParsedModelName) -> str | None:
    if parsed.family != ModelFamily.GEMMA:
        return None
    return _dotted_alias("gemma", parsed)


def _glm_alias(parsed: ParsedModelName) -> str | None:
    if parsed.family != ModelFamily.GLM:
        return None
    return _dotted_alias("glm", parsed)


def _grok_alias(parsed: ParsedModelName) -> str | None:
    if parsed.family != ModelFamily.GROK:
        return None
    return _dotted_alias("grok", parsed)


def _deepseek_alias(parsed: ParsedModelName) -> str | None:
    if parsed.family != ModelFamily.DEEPSEEK:
        return None
    version = f"v{parsed.version[0]}" if parsed.version else ""
    return _joined("deepseek", version, *parsed.model)


def _kimi_alias(parsed: ParsedModelName) -> str | None:
    if parsed.family != ModelFamily.KIMI:
        return None
    version = f"k{parsed.version[0]}" if parsed.version else ""
    return _joined("kimi", version, *parsed.model)


def _simple_alias(parsed: ParsedModelName) -> str | None:
    if parsed.family not in {
        ModelFamily.BGE,
        ModelFamily.GTE,
        ModelFamily.INKLING,
    }:
        return None
    return _joined(parsed.family.value, *parsed.model)


def _dotted_alias(family: str, parsed: ParsedModelName) -> str:
    return _joined(family, _dotted_version(parsed.version), *parsed.model)


def _dotted_version(version: tuple[int, ...]) -> str:
    return ".".join(map(str, version))


def _joined(*parts: object) -> str:
    return "-".join(str(part) for part in parts if str(part))


def _normalize_alias(value: str) -> str:
    return value.strip().casefold()


AliasGenerator = Callable[[ParsedModelName], str | None]

ALIAS_GENERATORS: tuple[AliasGenerator, ...] = (
    _openai_alias,
    _anthropic_alias,
    _gemini_alias,
    _qwen_alias,
    _llama_alias,
    _gemma_alias,
    _glm_alias,
    _grok_alias,
    _deepseek_alias,
    _kimi_alias,
    _simple_alias,
)
