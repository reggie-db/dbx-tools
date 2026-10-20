/**
 * Browser-safe contracts and client for AppKit brand generation.
 *
 * @module
 */

import { BrandContextSchema } from "@dbx-tools/shared-core";
import { z } from "zod";

const nonBlankString = z.string().trim().min(1);

/** Registered AppKit generator plugin name. */
export const GENERATOR_PLUGIN_NAME = "generator";

/** Default route prefix published by the generator plugin. */
export const GENERATOR_BASE_PATH = `/api/${GENERATOR_PLUGIN_NAME}`;

/** Mount-relative route segments owned by the generator plugin. */
export const GENERATOR_ROUTES = {
  generateBrand: "/brand/generate",
  brandHistory: "/brand/history",
} as const;

/** Input accepted by brand generation. */
export const BrandGenerationRequestSchema = z
  .object({
    name: nonBlankString
      .max(200)
      .optional()
      .describe("Known brand, organization, or product name."),
    prompt: nonBlankString
      .max(2_000)
      .optional()
      .describe("Open-ended brand brief used for research and generation."),
    website: z
      .string()
      .url()
      .refine((value) => new URL(value).protocol === "https:", "Expected an HTTPS website URL.")
      .optional()
      .describe("Known official website used to disambiguate the brand."),
  })
  .strict()
  .refine((value) => value.name !== undefined || value.prompt !== undefined, {
    message: "Brand generation requires a name or prompt.",
  })
  .describe("Request to research one brand and generate its portable branding package.");

/** Validated brand-generation request. */
export type BrandGenerationRequest = z.infer<typeof BrandGenerationRequestSchema>;

/** A cited source and whether its page content was available to synthesis. */
export const BrandPackageSourceSchema = z
  .object({
    url: z.string().url().describe("Source URL used during brand research."),
    title: nonBlankString.optional().describe("Source page title, when available."),
    snippet: nonBlankString.optional().describe("Search-result excerpt, when available."),
    fetched: z
      .boolean()
      .describe("True when web_fetch returned page content used during synthesis."),
  })
  .strict()
  .describe("Web source used to research the generated brand.");

/** Source provenance included in a generated branding package. */
export type BrandPackageSource = z.infer<typeof BrandPackageSourceSchema>;

/** One fetched mobile-app image used as visual brand research. */
export const BrandVisualImageSchema = z
  .object({
    url: z.string().url().describe("Original mobile-store image URL."),
    contentType: z.string().optional().describe("Fetched image media type."),
    localPath: z
      .string()
      .optional()
      .describe("Package-relative exported image path, when written by a CLI."),
  })
  .strict()
  .describe("Mobile-store image reference used for brand inspiration.");

/** Mobile-store image used as visual brand research. */
export type BrandVisualImage = z.infer<typeof BrandVisualImageSchema>;

/** App Store or Play Store page and its visual references. */
export const BrandVisualReferenceSchema = z
  .object({
    platform: z.enum(["ios", "android"]).describe("Mobile application platform."),
    appName: nonBlankString.describe("Application name read from the store page."),
    pageUrl: z.string().url().describe("Official application-store page."),
    images: z.array(BrandVisualImageSchema).describe("Fetched app icon or screenshots."),
  })
  .strict()
  .describe("Mobile application visuals consulted during brand research.");

/** Mobile-store brand research reference. */
export type BrandVisualReference = z.infer<typeof BrandVisualReferenceSchema>;

/** Portable generated brand context with research provenance. */
export const BrandPackageSchema = z
  .object({
    brand: BrandContextSchema.describe(
      "Portable brand context ready for @dbx-tools UI and email consumers.",
    ),
    sources: z
      .array(BrandPackageSourceSchema)
      .describe("Deduplicated web sources used to generate this package."),
    visualReferences: z
      .array(BrandVisualReferenceSchema)
      .default([])
      .describe("iOS and Android application visuals used for inspiration."),
  })
  .strict()
  .describe("Generated branding package and its web research provenance.");

/** Generated branding package. */
export type BrandPackage = z.infer<typeof BrandPackageSchema>;

/** One persisted generated brand available to the browser picker. */
export const BrandHistoryEntrySchema = z
  .object({
    id: nonBlankString.describe("Stable request-derived brand history identifier."),
    request: BrandGenerationRequestSchema.describe("Free-form request that generated the brand."),
    generatedAt: z.iso.datetime().describe("Time the generated brand was stored."),
    package: BrandPackageSchema.describe("Cached generated branding package."),
  })
  .strict()
  .describe("Persisted generated brand available to one user.");

/** Persisted generated brand available to one user. */
export type BrandHistoryEntry = z.infer<typeof BrandHistoryEntrySchema>;

/** Browser response containing the current user's generated brands. */
export const BrandHistoryResponseSchema = z
  .object({
    brands: z.array(BrandHistoryEntrySchema).describe("Generated brands, newest first."),
  })
  .strict()
  .describe("Current user's persisted generated-brand history.");

/** Current user's persisted generated-brand history. */
export type BrandHistoryResponse = z.infer<typeof BrandHistoryResponseSchema>;

/** Observable stages in one brand-generation workflow. */
export const BrandGenerationStageSchema = z.enum([
  "search",
  "fetch",
  "visuals",
  "assets",
  "synthesize",
]);

/** Observable brand-generation stage. */
export type BrandGenerationStage = z.infer<typeof BrandGenerationStageSchema>;

/** Progress emitted while the backend researches and synthesizes a brand. */
export const BrandGenerationProgressEventSchema = z
  .object({
    type: z.literal("progress"),
    stage: BrandGenerationStageSchema.describe("Current workflow stage."),
    message: nonBlankString.describe("Short user-facing progress message."),
    current: z.number().int().nonnegative().optional().describe("Completed items in this stage."),
    total: z.number().int().positive().optional().describe("Total items in this stage."),
  })
  .strict()
  .describe("Progress update from a running brand generation.");

/** Progress event emitted during brand generation. */
export type BrandGenerationProgressEvent = z.infer<typeof BrandGenerationProgressEventSchema>;

/** Final successful brand-generation event. */
export const BrandGenerationResultEventSchema = z
  .object({
    type: z.literal("result"),
    package: BrandPackageSchema.describe("Completed portable branding package."),
  })
  .strict()
  .describe("Successful completion of brand generation.");

/** Final successful brand-generation event. */
export type BrandGenerationResultEvent = z.infer<typeof BrandGenerationResultEventSchema>;

/** Final error event from a started brand-generation stream. */
export const BrandGenerationErrorEventSchema = z
  .object({
    type: z.literal("error"),
    message: nonBlankString.describe("Actionable generation failure message."),
  })
  .strict()
  .describe("Failure emitted after a brand-generation stream started.");

/** Final error event from a started brand-generation stream. */
export type BrandGenerationErrorEvent = z.infer<typeof BrandGenerationErrorEventSchema>;

/** Every server-sent event emitted by brand generation. */
export const BrandGenerationEventSchema = z.discriminatedUnion("type", [
  BrandGenerationProgressEventSchema,
  BrandGenerationResultEventSchema,
  BrandGenerationErrorEventSchema,
]);

/** Server-sent event emitted by brand generation. */
export type BrandGenerationEvent = z.infer<typeof BrandGenerationEventSchema>;

/** Browser-safe route configuration published by the AppKit generator plugin. */
export const GeneratorClientConfigSchema = z
  .object({
    basePath: nonBlankString.describe("Mounted API route prefix for the generator plugin."),
  })
  .strict()
  .describe("Browser configuration published by the AppKit generator plugin.");

/** Browser-safe generator plugin route configuration. */
export type GeneratorClientConfig = z.infer<typeof GeneratorClientConfigSchema>;

/** Options for one browser brand-generation stream. */
export interface BrandGenerationStreamOptions {
  /** Cancels the request and response stream. */
  signal?: AbortSignal;
  /** Fetch implementation. Defaults to the browser global. */
  fetch?: typeof globalThis.fetch;
}

/** Build the brand endpoint from the generator plugin's published base path. */
export function brandGenerateUrl(basePath: string = GENERATOR_BASE_PATH): string {
  return `${basePath.replace(/\/+$/, "")}${GENERATOR_ROUTES.generateBrand}`;
}

/** Build the generated-brand history endpoint from the published base path. */
export function brandHistoryUrl(basePath: string = GENERATOR_BASE_PATH): string {
  return `${basePath.replace(/\/+$/, "")}${GENERATOR_ROUTES.brandHistory}`;
}

/** Parse one complete SSE frame into its validated brand event. */
function parseEventFrame(frame: string): BrandGenerationEvent | undefined {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return undefined;
  const value: unknown = JSON.parse(data);
  return BrandGenerationEventSchema.parse(value);
}

/** Read a failed HTTP response without trusting its payload shape. */
async function responseError(response: Response): Promise<string> {
  const value: unknown = await response
    .clone()
    .json()
    .catch(() => undefined);
  if (typeof value === "object" && value !== null && "error" in value) {
    const message = value.error;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  const text = await response.text().catch(() => "");
  return text.trim() || `Brand generation failed (${response.status}).`;
}

/** Browser client for the generator plugin's streamed routes. */
export class GeneratorPluginClient {
  private readonly config: GeneratorClientConfig;

  /** Create a client from the plugin's published `clientConfig()` payload. */
  constructor(config: GeneratorClientConfig) {
    this.config = GeneratorClientConfigSchema.parse(config);
  }

  /** Generate a brand while yielding validated progress and terminal events. */
  async *generate(
    input: BrandGenerationRequest,
    options: BrandGenerationStreamOptions = {},
  ): AsyncGenerator<BrandGenerationEvent> {
    const request = BrandGenerationRequestSchema.parse(input);
    const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    const response = await fetcher(brandGenerateUrl(this.config.basePath), {
      method: "POST",
      headers: {
        Accept: "text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok) throw new Error(await responseError(response));
    if (!response.body) throw new Error("Brand generation returned no event stream.");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done }).replaceAll("\r\n", "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const event = parseEventFrame(buffer.slice(0, boundary));
        if (event) yield event;
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
      }
      if (done) break;
    }
    const event = parseEventFrame(buffer.trim());
    if (event) yield event;
  }

  /** List the current user's persisted generated brands, newest first. */
  async brandHistory(options: BrandGenerationStreamOptions = {}): Promise<BrandHistoryEntry[]> {
    const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    const response = await fetcher(brandHistoryUrl(this.config.basePath), {
      method: "GET",
      headers: { Accept: "application/json" },
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok) throw new Error(await responseError(response));
    return BrandHistoryResponseSchema.parse(await response.json()).brands;
  }
}
