/**
 * Browser-safe HTTP model, embedding, and error payloads.
 *
 * @module
 */

import { model } from "@dbx-tools/shared-model";
import { z } from "zod";

/** Capabilities published with an OpenAI-compatible model entry. */
export const OpenAIModelCapabilitiesSchema = z.object({
  tools: z.boolean(),
  reasoning: z.array(model.ReasoningEffortSchema),
  responses: z.boolean(),
  open_responses: z.boolean(),
  anthropic: z.boolean(),
  embeddings: z.boolean(),
  ai_gateway_codex: z.boolean(),
  streaming: z.boolean(),
});
/** Capabilities published with an OpenAI-compatible model entry. */
export type OpenAIModelCapabilities = z.infer<typeof OpenAIModelCapabilitiesSchema>;

/** One OpenAI-compatible model-list entry. */
export const OpenAIModelSchema = z.object({
  id: z.string().min(1),
  object: z.literal("model"),
  created: z.number().int().nonnegative(),
  owned_by: z.string().min(1),
  name: z.string().min(1),
  task: z.string().optional(),
  status: model.ModelStatusSchema,
  capabilities: OpenAIModelCapabilitiesSchema,
});
/** One OpenAI-compatible model-list entry. */
export type OpenAIModel = z.infer<typeof OpenAIModelSchema>;

/** Standard OpenAI model-list response. */
export const OpenAIModelListResponseSchema = z.object({
  object: z.literal("list"),
  data: z.array(OpenAIModelSchema),
});
/** Standard OpenAI model-list response. */
export type OpenAIModelListResponse = z.infer<typeof OpenAIModelListResponseSchema>;

/** Reasoning effort advertised to Codex. */
export const CodexReasoningLevelSchema = z.object({
  effort: model.ReasoningEffortSchema,
  description: z.string(),
});
/** Reasoning effort advertised to Codex. */
export type CodexReasoningLevel = z.infer<typeof CodexReasoningLevelSchema>;

/** Codex client-side transcript truncation policy. */
export const CodexTruncationPolicySchema = z.object({
  mode: z.enum(["tokens", "bytes"]),
  limit: z.number().int().positive(),
});
/** Codex client-side transcript truncation policy. */
export type CodexTruncationPolicy = z.infer<typeof CodexTruncationPolicySchema>;

/** One Codex model-catalog entry. */
export const CodexModelSchema = z.object({
  slug: z.string().min(1),
  display_name: z.string().min(1),
  description: z.string(),
  base_instructions: z.string(),
  status: model.ModelStatusSchema,
  supported_reasoning_levels: z.array(CodexReasoningLevelSchema),
  default_reasoning_level: model.ReasoningEffortSchema.optional(),
  shell_type: z.string().min(1),
  visibility: z.literal("list"),
  supported_in_api: z.boolean(),
  priority: z.number().int().positive(),
  availability_nux: z.unknown().nullable(),
  upgrade: z.unknown().nullable(),
  support_verbosity: z.boolean(),
  default_verbosity: z.string().nullable(),
  apply_patch_tool_type: z.string().nullable(),
  truncation_policy: CodexTruncationPolicySchema,
  context_window: z.number().int().positive().nullable(),
  experimental_supported_tools: z.array(z.unknown()),
  input_modalities: z.array(z.string()),
  web_search_tool_type: z.string(),
  supports_search_tool: z.boolean(),
  supports_image_detail_original: z.boolean(),
});
/** One Codex model-catalog entry. */
export type CodexModel = z.infer<typeof CodexModelSchema>;

/** Codex-native model-list response. */
export const CodexModelListResponseSchema = z.object({
  models: z.array(CodexModelSchema),
});
/** Codex-native model-list response. */
export type CodexModelListResponse = z.infer<typeof CodexModelListResponseSchema>;

/** Model-list response selected by the caller's Originator header. */
export const ModelListResponseSchema = z.union([
  OpenAIModelListResponseSchema,
  CodexModelListResponseSchema,
]);
/** Model-list response selected by the caller's Originator header. */
export type ModelListResponse = z.infer<typeof ModelListResponseSchema>;

/** OpenAI-compatible embeddings request. */
export const EmbeddingRequestSchema = z.object({
  model: z.string().min(1),
  input: z.union([z.string(), z.array(z.string())]),
  encoding_format: z.enum(["float", "base64"]).optional(),
  dimensions: z.number().int().positive().optional(),
  user: z.string().optional(),
});
/** OpenAI-compatible embeddings request. */
export type EmbeddingRequest = z.infer<typeof EmbeddingRequestSchema>;

/** One embedding vector in an OpenAI-compatible response. */
export const EmbeddingDataSchema = z.object({
  object: z.literal("embedding"),
  embedding: z.union([z.array(z.number()), z.string()]),
  index: z.number().int().nonnegative(),
});
/** One embedding vector in an OpenAI-compatible response. */
export type EmbeddingData = z.infer<typeof EmbeddingDataSchema>;

/** Token usage for an embeddings request. */
export const EmbeddingUsageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
});
/** Token usage for an embeddings request. */
export type EmbeddingUsage = z.infer<typeof EmbeddingUsageSchema>;

/** OpenAI-compatible embeddings response. */
export const EmbeddingResponseSchema = z.object({
  object: z.literal("list"),
  data: z.array(EmbeddingDataSchema),
  model: z.string(),
  usage: EmbeddingUsageSchema,
});
/** OpenAI-compatible embeddings response. */
export type EmbeddingResponse = z.infer<typeof EmbeddingResponseSchema>;

/** OpenAI-compatible error response. */
export const OpenAIErrorResponseSchema = z.object({
  error: z.object({
    message: z.string(),
    type: z.string(),
    code: z.union([z.string(), z.number(), z.null()]).optional(),
  }),
});
/** OpenAI-compatible error response. */
export type OpenAIErrorResponse = z.infer<typeof OpenAIErrorResponseSchema>;

/** Anthropic-compatible error response. */
export const AnthropicErrorResponseSchema = z.object({
  type: z.literal("error"),
  error: z.object({
    type: z.string(),
    message: z.string(),
  }),
});
/** Anthropic-compatible error response. */
export type AnthropicErrorResponse = z.infer<typeof AnthropicErrorResponseSchema>;

/** Error response emitted by any gateway compatibility surface. */
export const GatewayErrorResponseSchema = z.union([
  OpenAIErrorResponseSchema,
  AnthropicErrorResponseSchema,
]);
/** Error response emitted by any gateway compatibility surface. */
export type GatewayErrorResponse = z.infer<typeof GatewayErrorResponseSchema>;
