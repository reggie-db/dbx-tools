from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, ConfigDict, Field


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


class ModelQuery(WireModel):
    search: str | None = None
    model_class: ModelClass | None = Field(default=None, alias="modelClass")
    requires_tools: bool | None = Field(default=None, alias="requiresTools")
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
