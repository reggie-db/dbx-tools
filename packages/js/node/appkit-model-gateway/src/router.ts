/**
 * Pure capability-driven route selection for model-gateway requests.
 *
 * @module
 */

import type {
  GatewayRoute,
  ModelTarget,
  RequestedFeatures,
  ResolveRouteInput,
  UpstreamProtocol,
} from "@dbx-tools/shared-model-gateway";

/** Error returned when preserving a requested protocol feature is impossible. */
export class UnsupportedGatewayFeatureError extends Error {
  readonly status = 400;

  constructor(readonly features: readonly string[]) {
    super(`The selected model cannot preserve requested features: ${features.join(", ")}`);
    this.name = "UnsupportedGatewayFeatureError";
  }
}

/** Select the lowest-overhead upstream that preserves the client contract. */
export function resolveRoute(input: ResolveRouteInput): GatewayRoute {
  const { clientProtocol, requestedModel, features, target } = input;
  if (clientProtocol === "openai-embeddings") {
    if (!target.capabilities.embeddings) {
      throw new UnsupportedGatewayFeatureError(["embeddings"]);
    }
    return directRoute(input, "databricks-embeddings", target.id);
  }
  if (clientProtocol === "openai-responses") {
    rejectStatefulResponses(features);
    if (
      isCodexOriginator(input.originator) &&
      targetsModelService(requestedModel, target) &&
      target.capabilities.aiGatewayCodex &&
      supportsDirectResponses(target, features)
    ) {
      return directRoute(input, "databricks-ai-gateway-codex", target.modelServiceName!);
    }
    if (target.capabilities.responses && supportsDirectResponses(target, features)) {
      return directRoute(input, "databricks-responses", target.id);
    }
    if (
      target.capabilities.aiGatewayCodex &&
      target.modelServiceName &&
      supportsDirectResponses(target, features)
    ) {
      return directRoute(input, "databricks-ai-gateway-codex", target.modelServiceName);
    }
    if (target.capabilities.openResponses && supportsOpenResponses(target, features)) {
      return directRoute(input, "databricks-open-responses", target.id);
    }
    return translatedRoute(input);
  }

  if (clientProtocol === "openai-chat") {
    if (target.capabilities.chat && supportsTools(target, features)) {
      return directRoute(input, "databricks-chat", target.id);
    }
    return translatedRoute(input);
  }

  if (target.capabilities.anthropic && supportsTools(target, features)) {
    return directRoute(input, "databricks-anthropic", target.id);
  }
  return translatedRoute(input);
}

/** Detect route-affecting features from an OpenAI or Anthropic request body. */
export function requestedFeatures(body: Readonly<Record<string, unknown>>): RequestedFeatures {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const toolTypes = tools
    .filter((tool): tool is Record<string, unknown> => isRecord(tool))
    .map((tool) => tool.type);
  const text = isRecord(body.text) ? body.text : {};
  const format = isRecord(text.format) ? text.format.type : text.format;
  return {
    background: body.background === true,
    customTools: toolTypes.some((type) => type === "custom"),
    parallelTools: body.parallel_tool_calls === true,
    previousResponse:
      typeof body.previous_response_id === "string" && body.previous_response_id.length > 0,
    reasoning: isRecord(body.reasoning) || body.reasoning_effort !== undefined,
    storage: body.store === true,
    structuredOutput: format !== undefined && format !== "text",
    tools: tools.length > 0,
    unsupportedOpenResponsesTools: toolTypes.some(
      (type) => type !== "function" && type !== "web_search" && type !== "web_search_preview",
    ),
    webSearch: toolTypes.some((type) => type === "web_search" || type === "web_search_preview"),
  };
}

/** Return whether an Originator header selects Codex compatibility behavior. */
export function isCodexOriginator(originator: string | undefined): boolean {
  return originator?.toLowerCase().includes("codex") === true;
}

function directRoute(
  input: ResolveRouteInput,
  upstreamProtocol: Exclude<UpstreamProtocol, "ai-sdk">,
  upstreamModel: string,
): GatewayRoute {
  return {
    clientProtocol: input.clientProtocol,
    upstreamProtocol,
    target: input.target,
    upstreamModel,
    translateRequest: false,
    translateResponse: false,
  };
}

function translatedRoute(input: ResolveRouteInput): GatewayRoute {
  return {
    clientProtocol: input.clientProtocol,
    upstreamProtocol: "ai-sdk",
    target: input.target,
    upstreamModel: input.target.id,
    translateRequest: true,
    translateResponse: true,
  };
}

function supportsDirectResponses(target: ModelTarget, features: RequestedFeatures): boolean {
  return (
    supportsTools(target, features) &&
    (!features.customTools || target.capabilities.customTools) &&
    (!features.structuredOutput || target.capabilities.structuredOutput)
  );
}

function supportsOpenResponses(target: ModelTarget, features: RequestedFeatures): boolean {
  return (
    supportsTools(target, features) &&
    !features.customTools &&
    !features.previousResponse &&
    !features.storage &&
    !features.background &&
    !features.unsupportedOpenResponsesTools &&
    (!features.webSearch || target.capabilities.webSearch) &&
    (!features.structuredOutput || target.capabilities.structuredOutput)
  );
}

function supportsTools(target: ModelTarget, features: RequestedFeatures): boolean {
  return (
    (!features.tools || target.capabilities.tools) &&
    (!features.parallelTools || target.capabilities.parallelTools)
  );
}

function rejectStatefulResponses(features: RequestedFeatures): void {
  const unsupported = [
    ...(features.previousResponse ? ["previous_response_id"] : []),
    ...(features.storage ? ["store"] : []),
    ...(features.background ? ["background"] : []),
  ];
  if (unsupported.length > 0) throw new UnsupportedGatewayFeatureError(unsupported);
}

function targetsModelService(requestedModel: string, target: ModelTarget): boolean {
  if (!target.modelServiceName) return false;
  const unqualified = requestedModel.trim().replace(/^(?:dbx|databricks)\//i, "");
  return unqualified === target.modelServiceName;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
