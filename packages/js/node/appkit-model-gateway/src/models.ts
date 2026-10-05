/**
 * OpenAI and Codex model-list payloads derived from the live registry.
 *
 * @module
 */

import { isChatClass } from "@dbx-tools/model/classes";
import { modelFamily } from "@dbx-tools/model/policy";
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
    .sort((left, right) =>
      compareCatalogueTargets(left, right, (target) => target.displayName),
    );
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
 * Order listed models in three groups: non-embedding models with a detected
 * family, the remaining non-embedding models, then embeddings. Each group is
 * sorted by the published label (`display_name` for Codex, `name` otherwise)
 * with numeric segments ordered naturally so "Veo 3.1" precedes "Veo 3.10".
 */
function compareCatalogueTargets(
  left: ModelTarget,
  right: ModelTarget,
  label: (target: ModelTarget) => string,
): number {
  const group = catalogueGroup(left) - catalogueGroup(right);
  if (group !== 0) return group;
  return compareCatalogueLabel(label(left), label(right));
}

function catalogueGroup(target: ModelTarget): number {
  if (isEmbeddingTarget(target)) return 2;
  return catalogueFamily(target) ? 0 : 1;
}

function catalogueFamily(target: ModelTarget): string | undefined {
  const stamped = target.family?.trim() || target.endpoint?.family?.trim();
  return (
    modelFamily(target.displayName) ??
    modelFamily(target.id) ??
    (target.endpoint?.name ? modelFamily(target.endpoint.name) : undefined) ??
    (stamped ? modelFamily(stamped) : undefined)
  );
}

function isEmbeddingTarget(target: ModelTarget): boolean {
  return (
    target.capabilities.embeddings === true || target.endpoint?.task === "llm/v1/embeddings"
  );
}

function compareCatalogueLabel(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

function hasChatClass(target: ModelTarget): boolean {
  const modelClass = target.endpoint?.class;
  return modelClass !== undefined && isChatClass(modelClass);
}
