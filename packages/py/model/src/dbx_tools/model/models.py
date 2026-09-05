from __future__ import annotations

import re
from dataclasses import dataclass
from enum import Enum

from pydantic import BaseModel, ConfigDict, Field

from .model_status import ModelStatus

"""Model contracts and shared model-name parsing."""


class ModelFamily(str, Enum):
    BGE = "bge"
    CLAUDE = "claude"
    DEEPSEEK = "deepseek"
    GEMINI = "gemini"
    GEMMA = "gemma"
    GLM = "glm"
    GPT = "gpt"
    GROK = "grok"
    GTE = "gte"
    INKLING = "inkling"
    KIMI = "kimi"
    LLAMA = "llama"
    QWEN = "qwen"


class ModelService(str, Enum):
    ALIBABA = "alibaba"
    ANTHROPIC = "anthropic"
    DEEPSEEK = "deepseek"
    GOOGLE = "google"
    META = "meta"
    MOONSHOT = "moonshot"
    OPENAI = "openai"
    XAI = "xai"
    ZHIPU = "zhipu"


MODEL_FAMILIES = frozenset(ModelFamily)
VERSIONED_MODEL_FAMILIES = frozenset(
    family
    for family in ModelFamily
    if family not in {ModelFamily.BGE, ModelFamily.GTE, ModelFamily.INKLING}
)

_MODEL_FAMILIES_BY_NAME = {family.value: family for family in MODEL_FAMILIES}


@dataclass(frozen=True)
class ParsedModelName:
    """Provider-neutral family, version, and model components."""

    source: str
    family: ModelFamily
    version: tuple[int, ...]
    model: tuple[str, ...]


class ModelClass(str, Enum):
    CHAT_THINKING = "chat-thinking"
    CHAT_BALANCED = "chat-balanced"
    CHAT_FAST = "chat-fast"
    EMBEDDING = "embedding"


class ReasoningEffort(str, Enum):
    NONE = "none"
    MINIMAL = "minimal"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    XHIGH = "xhigh"
    MAX = "max"


class WireModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    def as_dict(self) -> dict[str, object]:
        return self.model_dump(by_alias=True, exclude_none=True, mode="json")


class ModelProfile(WireModel):
    quality: float | None = None
    speed: float | None = None
    cost: float | None = None


class ServingEndpointSummary(WireModel):
    name: str
    display_name: str | None = Field(default=None, alias="displayName")
    task: str | None = None
    state: str | None = None
    description: str | None = None
    supports_tools: bool | None = Field(default=None, alias="supportsTools")
    profile: ModelProfile | None = None
    model_class: ModelClass | None = Field(default=None, alias="class")
    dimension: int | None = None
    reasoning_efforts: tuple[ReasoningEffort, ...] = Field(default=(), alias="reasoningEfforts")
    service_names: dict[ModelService, str] = Field(default_factory=dict, alias="serviceNames")
    status: ModelStatus = Field(default_factory=ModelStatus)


class ModelQuery(WireModel):
    search: str | None = None
    model_class: ModelClass | None = Field(default=None, alias="modelClass")
    requires_tools: bool | None = Field(default=None, alias="requiresTools")
    include_deprecated: bool = Field(default=False, alias="includeDeprecated")
    limit: int | None = None
    threshold: float | None = None


class RankedModel(WireModel):
    endpoint: ServingEndpointSummary
    model_class: ModelClass = Field(alias="modelClass")
    score: float | None = None


class ResolvedModel(WireModel):
    model_id: str = Field(alias="modelId")
    matched: bool
    score: float | None = None


class ResolvedModelSelection(WireModel):
    model_id: str = Field(alias="modelId")
    source: str


class EndpointCapabilities(WireModel):
    chat: bool
    embedding: bool
    tools: bool
    reasoning_efforts: tuple[ReasoningEffort, ...] = Field(default=(), alias="reasoningEfforts")


def parse_model_name(value: str) -> ParsedModelName | None:
    """Parse provider and routed model names into stable identity components."""
    source = value.strip()
    if not source:
        return None
    tokens = re.findall(r"[a-z0-9]+", source.casefold())
    family_match = _find_model_family(tokens)
    if family_match is None:
        return None

    family_index, family, embedded_version = family_match
    remainder = tokens[family_index + 1 :]
    if family == ModelFamily.QWEN:
        version, model = _parse_qwen_parts(embedded_version, remainder)
    elif family == ModelFamily.CLAUDE:
        version, model = _parse_claude_parts(remainder)
    elif family == ModelFamily.DEEPSEEK:
        version, model = _parse_prefixed_version(remainder, "v")
    elif family == ModelFamily.KIMI:
        version, model = _parse_prefixed_version(remainder, "k")
    else:
        version, model = _parse_leading_version(remainder)
    return ParsedModelName(source=source, family=family, version=version, model=model)


def model_search_query(value: str | ParsedModelName) -> str | None:
    """Render a parsed model identity as provider-neutral fuzzy search terms."""
    parsed = value if isinstance(value, ParsedModelName) else parse_model_name(value)
    if parsed is None:
        return None
    return " ".join(
        (
            parsed.family.value,
            *(str(part) for part in parsed.version),
            *parsed.model,
        )
    )


def model_service_names(value: str | ParsedModelName) -> dict[ModelService, str]:
    """Return canonical first-party service names for a model identity."""
    parsed = value if isinstance(value, ParsedModelName) else parse_model_name(value)
    if parsed is None:
        return {}
    service_name = _SERVICE_NAMES_BY_FAMILY.get(parsed.family)
    if service_name is None:
        return {}
    service, name_for = service_name
    name = name_for(parsed)
    return {service: name} if name is not None else {}


def version_tuple(name: str) -> list[int]:
    """Return sortable major, minor, and patch components from a model name."""
    match = re.search(r"\d", name)
    if match is None:
        return [0, 0, 0]
    parts = re.split(r"[^a-z0-9]+", name[match.start() :], flags=re.IGNORECASE)
    numbers = _numeric_prefixes(parts)
    return (numbers + [0, 0, 0])[:3]


def _dotted_name(prefix: str, parsed: ParsedModelName) -> str | None:
    if not parsed.version and not parsed.model:
        return None
    version = ".".join(str(part) for part in parsed.version)
    return _joined_name(prefix, version, *parsed.model)


def _claude_name(parsed: ParsedModelName) -> str | None:
    return _joined_name(
        "claude",
        *parsed.model[:1],
        *(str(part) for part in parsed.version),
        *parsed.model[1:],
    )


def _gpt_name(parsed: ParsedModelName) -> str | None:
    if parsed.model[:1] == ("oss",):
        return None
    return _dotted_name("gpt", parsed)


def _prefixed_version_name(prefix: str, marker: str, parsed: ParsedModelName) -> str | None:
    version = f"{marker}{parsed.version[0]}" if parsed.version else ""
    return _joined_name(prefix, version, *parsed.model)


def _qwen_name(parsed: ParsedModelName) -> str | None:
    if not parsed.version:
        return None
    suffix = f"-{'-'.join(parsed.model)}" if parsed.model else ""
    return f"qwen{'.'.join(str(part) for part in parsed.version)}{suffix}"


def _joined_name(*parts: str) -> str | None:
    value = "-".join(part for part in parts if part)
    return value or None


_SERVICE_NAMES_BY_FAMILY = {
    ModelFamily.CLAUDE: (ModelService.ANTHROPIC, _claude_name),
    ModelFamily.DEEPSEEK: (
        ModelService.DEEPSEEK,
        lambda parsed: _prefixed_version_name("deepseek", "v", parsed),
    ),
    ModelFamily.GEMINI: (ModelService.GOOGLE, lambda parsed: _dotted_name("gemini", parsed)),
    ModelFamily.GEMMA: (ModelService.GOOGLE, lambda parsed: _dotted_name("gemma", parsed)),
    ModelFamily.GLM: (ModelService.ZHIPU, lambda parsed: _dotted_name("glm", parsed)),
    ModelFamily.GPT: (ModelService.OPENAI, _gpt_name),
    ModelFamily.GROK: (ModelService.XAI, lambda parsed: _dotted_name("grok", parsed)),
    ModelFamily.KIMI: (
        ModelService.MOONSHOT,
        lambda parsed: _prefixed_version_name("kimi", "k", parsed),
    ),
    ModelFamily.LLAMA: (ModelService.META, lambda parsed: _dotted_name("llama", parsed)),
    ModelFamily.QWEN: (ModelService.ALIBABA, _qwen_name),
}


def _find_model_family(
    tokens: list[str],
) -> tuple[int, ModelFamily, tuple[int, ...]] | None:
    exact: list[tuple[int, ModelFamily, tuple[int, ...]]] = []
    for index, token in enumerate(tokens):
        family = _MODEL_FAMILIES_BY_NAME.get(token)
        if family is not None:
            exact.append((index, family, ()))
        qwen = re.fullmatch(r"qwen(?P<version>\d+)", token)
        if qwen is not None:
            return index, ModelFamily.QWEN, _compact_version(qwen.group("version"))
    return exact[-1] if exact else None


def _compact_version(value: str) -> tuple[int, ...]:
    if len(value) == 2:
        return int(value[0]), int(value[1])
    return (int(value),)


def _parse_qwen_parts(
    embedded_version: tuple[int, ...],
    remainder: list[str],
) -> tuple[tuple[int, ...], tuple[str, ...]]:
    if embedded_version:
        version = embedded_version
        if len(version) == 1 and remainder and remainder[0].isdigit():
            version = (*version, int(remainder[0]))
            remainder = remainder[1:]
        return version, tuple(remainder)
    return _parse_leading_version(remainder)


def _parse_claude_parts(
    remainder: list[str],
) -> tuple[tuple[int, ...], tuple[str, ...]]:
    start = next((index for index, token in enumerate(remainder) if token.isdigit()), None)
    if start is None:
        return (), tuple(remainder)
    version, suffix = _take_version(remainder[start:])
    return version, (*remainder[:start], *suffix)


def _parse_prefixed_version(
    remainder: list[str],
    prefix: str,
) -> tuple[tuple[int, ...], tuple[str, ...]]:
    if not remainder:
        return (), ()
    match = re.fullmatch(rf"{prefix}(?P<version>\d+)", remainder[0])
    if match is None:
        return _parse_leading_version(remainder)
    return (int(match.group("version")),), tuple(remainder[1:])


def _parse_leading_version(
    remainder: list[str],
) -> tuple[tuple[int, ...], tuple[str, ...]]:
    version, model = _take_version(remainder)
    return version, tuple(model)


def _take_version(parts: list[str]) -> tuple[tuple[int, ...], list[str]]:
    count = 0
    while count < min(2, len(parts)) and parts[count].isdigit():
        count += 1
    return tuple(int(value) for value in parts[:count]), parts[count:]


def _numeric_prefixes(parts: tuple[str, ...] | list[str]) -> list[int]:
    numbers = []
    for part in parts:
        digits = re.match(r"^\d+", part)
        if digits:
            numbers.append(int(digits.group(0)))
    return numbers
