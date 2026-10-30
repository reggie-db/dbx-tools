/**
 * OpenAI and Codex model-list payloads derived from the live registry.
 *
 * @module
 */

import {
  CHAT_CLASS_ORDER,
  compareVersionTuples,
  isChatClass,
  isOpenWeightsGpt,
  ModelFamily,
  modelFamily,
  modelFamilyRank,
  versionTuple,
} from "@dbx-tools/model";
import { ModelClass, ReasoningEffort } from "@dbx-tools/shared-model";
import { AI_DECIDE_MODEL_ID, SMART_ROUTER_MODEL_ID } from "@dbx-tools/shared-model-gateway";
import type {
  CodexModel,
  CodexModelListResponse,
  ModelCapabilities,
  ModelListResponse,
  ModelTarget,
  OpenAIModel,
  OpenAIModelListResponse,
} from "@dbx-tools/shared-model-gateway";

const CODEX_BASE_INSTRUCTIONS =
  "You are a coding agent. Follow the user's instructions and use the available tools to work in the current repository.";
const CODEX_SMART_ROUTER_PRIORITY = 9_000;
const CODEX_AI_DECIDE_PRIORITY = 9_001;
const CODEX_MODEL_PRIORITY_BASE = 10_000;
const CODEX_FAMILY_ORDER = [
  ModelFamily.Gpt,
  ...Object.values(ModelFamily).filter((family) => family !== ModelFamily.Gpt),
] as const;

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
  preserveOrder?: boolean,
  preferSystemModels?: boolean,
  includeSmartRouter?: boolean,
  includeAiDecide?: boolean,
): CodexModelListResponse;
export function listModelsPayload(
  targets: readonly ModelTarget[],
  includeCodex: false,
  preserveOrder?: boolean,
  preferSystemModels?: boolean,
  includeSmartRouter?: boolean,
  includeAiDecide?: boolean,
): OpenAIModelListResponse;
export function listModelsPayload(
  targets: readonly ModelTarget[],
  includeCodex: boolean,
  preserveOrder?: boolean,
  preferSystemModels?: boolean,
  includeSmartRouter?: boolean,
  includeAiDecide?: boolean,
): ModelListResponse;
export function listModelsPayload(
  targets: readonly ModelTarget[],
  includeCodex: boolean,
  preserveOrder = false,
  preferSystemModels = false,
  includeSmartRouter = false,
  includeAiDecide = false,
): ModelListResponse {
  const available = targets
    .filter((target) => target.endpoint?.status?.deprecated !== true)
    .filter((target) => !includeCodex || hasChatClass(target));
  if (!preserveOrder) {
    available.sort(
      includeCodex
        ? compareCodexCatalogueTargets
        : (left, right) => compareCatalogueTargets(left, right, (target) => target.displayName),
    );
  }
  const smartRouterCandidates = available.filter((target) => target.capabilities.chat);
  if (includeAiDecide && smartRouterCandidates.length > 0) {
    available.unshift(aiDecideModelTarget(smartRouterCandidates));
  }
  if (includeSmartRouter && smartRouterCandidates.length > 0) {
    available.unshift(smartRouterModelTarget(smartRouterCandidates));
  }
  if (includeCodex) {
    let modelIndex = 0;
    return {
      models: available.map((target) =>
        codexModel(
          target,
          target.id === SMART_ROUTER_MODEL_ID
            ? CODEX_SMART_ROUTER_PRIORITY
            : target.id === AI_DECIDE_MODEL_ID
              ? CODEX_AI_DECIDE_PRIORITY
              : CODEX_MODEL_PRIORITY_BASE + modelIndex++,
          preferSystemModels,
        ),
      ),
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
    model_source: target.endpoint?.modelSource ?? "custom",
    task: target.endpoint?.task,
    status: target.endpoint?.status ?? { deprecated: false },
    capabilities: {
      smart_router: target.id === SMART_ROUTER_MODEL_ID,
      ai_decide: target.id === AI_DECIDE_MODEL_ID,
      tools: target.capabilities.tools,
      reasoning: target.reasoningEfforts,
      responses: target.capabilities.responses,
      open_responses: target.capabilities.openResponses,
      anthropic: target.capabilities.anthropic,
      embeddings: target.capabilities.embeddings,
      ai_gateway_codex: target.capabilities.aiGatewayCodex,
      streaming: target.capabilities.streaming,
      web_search: target.capabilities.webSearch,
      image_input: target.capabilities.imageInput,
      apply_patch: target.capabilities.applyPatch,
    },
  };
}

function aiDecideModelTarget(candidates: readonly ModelTarget[]): ModelTarget {
  const has = (capability: keyof ModelCapabilities) =>
    candidates.some((target) => target.capabilities[capability]);
  const reasoningEfforts = Object.values(ReasoningEffort).filter((effort) =>
    candidates.some((target) => target.reasoningEfforts.includes(effort)),
  );
  return {
    id: AI_DECIDE_MODEL_ID,
    aliases: [AI_DECIDE_MODEL_ID],
    displayName: "AI Decide",
    endpoint: {
      name: AI_DECIDE_MODEL_ID,
      displayName: "AI Decide",
      description: "Uses Databricks ai_decide to choose a sufficient foundation model.",
      task: "llm/v1/chat",
      class: ModelClass.ChatBalanced,
      modelSource: "foundation",
      status: { deprecated: false },
    },
    capabilities: {
      responses: true,
      openResponses: true,
      chat: true,
      anthropic: true,
      embeddings: false,
      aiGatewayCodex: true,
      tools: has("tools"),
      reasoning: reasoningEfforts.length > 0,
      streaming: true,
      parallelTools: has("parallelTools"),
      customTools: has("customTools"),
      structuredOutput: has("structuredOutput"),
      webSearch: has("webSearch"),
      imageInput: has("imageInput"),
      applyPatch: has("applyPatch"),
    },
    reasoningEfforts,
  };
}

function smartRouterModelTarget(candidates: readonly ModelTarget[]): ModelTarget {
  const has = (capability: keyof ModelCapabilities) =>
    candidates.some((target) => target.capabilities[capability]);
  const reasoningEfforts = Object.values(ReasoningEffort).filter((effort) =>
    candidates.some((target) => target.reasoningEfforts.includes(effort)),
  );
  return {
    id: SMART_ROUTER_MODEL_ID,
    aliases: [SMART_ROUTER_MODEL_ID],
    displayName: "Smart Router",
    endpoint: {
      name: SMART_ROUTER_MODEL_ID,
      displayName: "Smart Router",
      description:
        "Uses Databricks task_v3 Smart Router to select a compatible system model for each turn.",
      task: "llm/v1/chat",
      class: ModelClass.ChatBalanced,
      modelSource: "foundation",
      status: { deprecated: false },
    },
    capabilities: {
      responses: true,
      openResponses: true,
      chat: true,
      anthropic: true,
      embeddings: false,
      aiGatewayCodex: true,
      tools: has("tools"),
      reasoning: reasoningEfforts.length > 0,
      streaming: true,
      parallelTools: has("parallelTools"),
      customTools: has("customTools"),
      structuredOutput: has("structuredOutput"),
      webSearch: has("webSearch"),
      imageInput: has("imageInput"),
      applyPatch: has("applyPatch"),
    },
    reasoningEfforts,
  };
}

/** Codex `/v1/models` slug: the `system.ai.*` service when preferred, else the endpoint id. */
export function codexModelSlug(target: ModelTarget, preferSystemModels: boolean): string {
  const model =
    preferSystemModels && target.capabilities.aiGatewayCodex && target.modelServiceName
      ? target.modelServiceName
      : target.id;
  return `databricks/${model}`;
}

function codexModel(
  target: ModelTarget,
  priority: number,
  preferSystemModels: boolean,
): CodexModel {
  const efforts = target.reasoningEfforts;
  return {
    slug: codexModelSlug(target, preferSystemModels),
    display_name: codexDisplayName(target),
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
    supports_search_tool: target.capabilities.webSearch,
    supports_image_detail_original: false,
  };
}

function codexDisplayName(target: ModelTarget): string {
  if (catalogueFamily(target) !== ModelFamily.Gpt) return target.displayName;
  const displayName = target.displayName.replace(/^gpt(?=[\s._-])/i, "GPT");
  return `Databricks ${displayName}`;
}

function compareCodexCatalogueTargets(left: ModelTarget, right: ModelTarget): number {
  const familyOrder = codexFamilyRank(left) - codexFamilyRank(right);
  if (familyOrder !== 0) return familyOrder;
  const modelKindOrder = codexModelKindRank(left) - codexModelKindRank(right);
  if (modelKindOrder !== 0) return modelKindOrder;
  const versionOrder = compareVersionTuples(codexVersion(right), codexVersion(left));
  if (versionOrder !== 0) return versionOrder;
  const classOrder = codexClassRank(left) - codexClassRank(right);
  if (classOrder !== 0) return classOrder;
  return compareCatalogueLabel(left.displayName, right.displayName);
}

function codexModelKindRank(target: ModelTarget): number {
  return [target.displayName, target.id, target.modelServiceName].some(
    (identity) => identity && isOpenWeightsGpt(identity),
  )
    ? 1
    : 0;
}

function codexFamilyRank(target: ModelTarget): number {
  const family = catalogueFamily(target);
  const index = family ? CODEX_FAMILY_ORDER.indexOf(family as ModelFamily) : -1;
  return index >= 0 ? index : CODEX_FAMILY_ORDER.length;
}

function codexVersion(target: ModelTarget): readonly number[] {
  return versionTuple(target.displayName);
}

function codexClassRank(target: ModelTarget): number {
  const modelClass = target.endpoint?.class;
  const index = modelClass ? CHAT_CLASS_ORDER.indexOf(modelClass) : -1;
  return index >= 0 ? index : CHAT_CLASS_ORDER.length;
}

/**
 * Order listed models in three groups: major-provider chat families, the
 * remaining chat models, then embeddings. Families keep a fixed provider
 * order; each family and the later groups sort by the published label
 * (`display_name` for Codex, `name` otherwise). Numeric segments sort
 * naturally so "Veo 3.1" precedes "Veo 3.10".
 */
function compareCatalogueTargets(
  left: ModelTarget,
  right: ModelTarget,
  label: (target: ModelTarget) => string,
): number {
  const group = catalogueGroup(left) - catalogueGroup(right);
  if (group !== 0) return group;
  const leftFamily = catalogueFamily(left);
  const rightFamily = catalogueFamily(right);
  if (leftFamily && rightFamily) {
    const familyOrder = modelFamilyRank(leftFamily) - modelFamilyRank(rightFamily);
    if (familyOrder !== 0) return familyOrder;
  }
  return compareCatalogueLabel(label(left), label(right));
}

function catalogueGroup(target: ModelTarget): number {
  if (isEmbeddingTarget(target)) return 2;
  return catalogueFamily(target) ? 0 : 1;
}

const IDENTITY_PREFIXES = new Set([
  "databricks",
  "system",
  "ai",
  "meta",
  "google",
  "openai",
  "anthropic",
]);

function catalogueFamily(target: ModelTarget): string | undefined {
  if (isEmbeddingTarget(target)) return undefined;
  for (const identity of [target.displayName, target.id, target.endpoint?.name]) {
    if (!identity) continue;
    const family = catalogueFamilyFromIdentity(identity);
    if (family) return family;
  }
  return undefined;
}

function catalogueFamilyFromIdentity(identity: string): string | undefined {
  const tokens = identity.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const start = tokens.find((token) => !IDENTITY_PREFIXES.has(token));
  if (!start) return undefined;
  if (start === "veo") return "gemini";
  const family = modelFamily(identity);
  return family && start === family ? family : undefined;
}

function isEmbeddingTarget(target: ModelTarget): boolean {
  return target.capabilities.embeddings === true || target.endpoint?.task === "llm/v1/embeddings";
}

function compareCatalogueLabel(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

function hasChatClass(target: ModelTarget): boolean {
  const modelClass = target.endpoint?.class;
  return modelClass !== undefined && isChatClass(modelClass);
}
