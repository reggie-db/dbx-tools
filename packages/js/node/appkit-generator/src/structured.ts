/**
 * Mastra-backed prompt-injected structured generation.
 *
 * @module
 */

import { buildModel, RESPONSES_PROVIDER_OPTIONS } from "@dbx-tools/appkit-mastra/model";
import { Agent } from "@mastra/core/agent";
import type { z } from "zod";

/** Options for one isolated structured synthesis pass. */
export interface StructuredGenerationOptions<TSchema extends z.ZodType> {
  /** Stable operation identifier. */
  id: string;
  /** Trusted system instructions. */
  instructions: string;
  /** Data-only prompt. */
  prompt: string;
  /** Zod-owned output contract. */
  schema: TSchema;
  /** Optional model preference. */
  model?: string;
  /** External cancellation. */
  signal?: AbortSignal;
}

/** Generate and validate one structured object without provider response-format APIs. */
export async function generateStructured<TSchema extends z.ZodType>(
  options: StructuredGenerationOptions<TSchema>,
): Promise<z.output<TSchema>> {
  const model = await buildModel(
    { modelOverride: false },
    undefined,
    options.model ? { modelId: options.model } : {},
  );
  const agent = new Agent({
    id: options.id,
    name: options.id,
    instructions: options.instructions,
    model,
  });
  const result = await agent.generate(options.prompt, {
    structuredOutput: {
      schema: options.schema,
      jsonPromptInjection: "system",
    },
    providerOptions: RESPONSES_PROVIDER_OPTIONS,
    ...(options.signal ? { abortSignal: options.signal } : {}),
  });
  return options.schema.parse(result.object);
}
