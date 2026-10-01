/**
 * Browser-safe model metadata projected from the Rust policy bindings.
 *
 * @module
 */

import {
  modelFamily as modelFamilyWithRust,
  reasoningEffortNamesByFamily,
  supportsToolsByFamily as supportsToolsByFamilyWithRust,
} from "@dbx-tools/model-rs";
import {
  model,
  ReasoningEffortSchema,
  type ReasoningEffort,
  type ServingEndpointSummary,
} from "@dbx-tools/shared-model";

/** Return the normalized family parsed by the Rust model-name policy. */
export function modelFamily(name: string): string | undefined {
  return modelFamilyWithRust(name);
}

/** Return the reasoning efforts accepted by a model family. */
export function modelReasoningEfforts(name: string): ReasoningEffort[] {
  return ReasoningEffortSchema.array().parse(reasoningEffortNamesByFamily(name));
}

/** Return whether Rust policy verifies a complete tool-calling round trip. */
export function modelSupportsTools(name: string): boolean {
  return supportsToolsByFamilyWithRust(name);
}

/** Return whether a discovered endpoint can be used for a tool-calling chat. */
export function endpointSupportsTools(endpoint: ServingEndpointSummary): boolean {
  const embedding =
    endpoint.task === "llm/v1/embeddings" || endpoint.class === model.ModelClass.Embedding;
  const chat = !embedding && (endpoint.task === "llm/v1/chat" || endpoint.class !== undefined);
  return chat && (endpoint.supportsTools ?? modelSupportsTools(endpoint.name));
}
