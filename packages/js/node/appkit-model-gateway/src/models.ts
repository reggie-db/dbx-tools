/**
 * OpenAI and Codex model-list payloads derived from the live registry.
 *
 * @module
 */

import { isChatClass } from "@dbx-tools/model/classes";
import type {
  CodexModel,
  CodexModelListResponse,
  ModelListResponse,
  ModelTarget,
  OpenAIModel,
  OpenAIModelListResponse,
} from "@dbx-tools/shared-model-gateway";

const CODEX_BASE_INSTRUCTIONS =
  "You are a coding agent. Follow the user's instructions and use the available tools to work in the current repository.";

const REASONING_DESCRIPTIONS: Readonly<Record<string, string>> = {
  none: "Disable explicit reasoning",
  minimal: "Use the smallest available reasoning budget",
  low: "Use a low reasoning budget",
  medium: "Use a medium reasoning budget",
  high: "Use a high reasoning budget",
  xhigh: "Use an extra-high reasoning budget",
  max: "Use the largest available reasoning budget",
};

/** Build the combined OpenAI and optional Codex model catalogue. */
export function listModelsPayload(
  targets: readonly ModelTarget[],
  includeCodex: true,
): CodexModelListResponse;
export function listModelsPayload(
  targets: readonly ModelTarget[],
  includeCodex: false,
): OpenAIModelListResponse;
export function listModelsPayload(
  targets: readonly ModelTarget[],
  includeCodex: boolean,
): ModelListResponse;
export function listModelsPayload(
  targets: readonly ModelTarget[],
  includeCodex: boolean,
): ModelListResponse {
  const available = targets
    .filter((target) => target.endpoint?.status?.deprecated !== true)
    .filter((target) => !includeCodex || hasChatClass(target))
    .slice()
    .sort(compareCatalogueTargets);
  if (includeCodex) {
    return {
      models: available.map((target, index) => codexModel(target, index + 1)),
    };
  }
  return {
    object: "list",
    data: available.map(openAiModel),
  };
}

function openAiModel(target: ModelTarget): OpenAIModel {
  return {
    id: target.id,
    object: "model",
    created: 0,
    owned_by: "databricks",
    name: target.displayName,
    task: target.endpoint?.task,
    status: target.endpoint?.status ?? { deprecated: false },
    capabilities: {
      tools: target.capabilities.tools,
      reasoning: target.reasoningEfforts,
      responses: target.capabilities.responses,
      open_responses: target.capabilities.openResponses,
      anthropic: target.capabilities.anthropic,
      embeddings: target.capabilities.embeddings,
      ai_gateway_codex: target.capabilities.aiGatewayCodex,
      streaming: target.capabilities.streaming,
    },
  };
}

function codexModel(target: ModelTarget, priority: number): CodexModel {
  const model =
    target.capabilities.aiGatewayCodex && target.modelServiceName
      ? target.modelServiceName
      : target.id;
  const efforts = target.reasoningEfforts;
  return {
    slug: `databricks/${model}`,
    display_name: target.displayName,
    description: target.endpoint?.description ?? "Databricks model service",
    base_instructions: CODEX_BASE_INSTRUCTIONS,
    status: target.endpoint?.status ?? { deprecated: false },
    supported_reasoning_levels: efforts.map((effort) => ({
      effort,
      description: REASONING_DESCRIPTIONS[effort] ?? `Use the ${effort} reasoning budget`,
    })),
    ...(efforts.length > 0
      ? { default_reasoning_level: efforts.includes("medium") ? "medium" : efforts[0] }
      : {}),
    shell_type: "unified_exec",
    visibility: "list",
    supported_in_api: true,
    priority,
    availability_nux: null,
    upgrade: null,
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: target.capabilities.customTools ? "freeform" : null,
    truncation_policy: { mode: "tokens", limit: 128_000 },
    context_window: null,
    experimental_supported_tools: [],
    input_modalities: ["text"],
    web_search_tool_type: "text",
    supports_search_tool: false,
    supports_image_detail_original: false,
  };
}

/**
 * Order listed models by family A-Z, then display name. Targets with no family
 * follow every named family, still sorted by display name.
 */
function compareCatalogueTargets(left: ModelTarget, right: ModelTarget): number {
  const leftFamily = catalogueFamily(left);
  const rightFamily = catalogueFamily(right);
  if (Boolean(leftFamily) !== Boolean(rightFamily)) return leftFamily ? -1 : 1;
  if (leftFamily && rightFamily) {
    const familyOrder = leftFamily.localeCompare(rightFamily, undefined, { sensitivity: "base" });
    if (familyOrder !== 0) return familyOrder;
  }
  return catalogueName(left).localeCompare(catalogueName(right), undefined, {
    sensitivity: "base",
  });
}

function catalogueFamily(target: ModelTarget): string | undefined {
  const family = target.family?.trim() || target.endpoint?.family?.trim();
  return family || undefined;
}

function catalogueName(target: ModelTarget): string {
  return target.displayName.trim() || target.id;
}

function hasChatClass(target: ModelTarget): boolean {
  const modelClass = target.endpoint?.class;
  return modelClass !== undefined && isChatClass(modelClass);
}
