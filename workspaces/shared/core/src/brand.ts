/**
 * Browser-safe brand contract, defaults, and LLM serialization helpers.
 *
 * Asset values are intentionally strings: they may be relative file paths,
 * package exports, data URLs, or network URLs depending on the consumer.
 */
import { z } from "zod";

const nonBlankString = z.string().trim().min(1);
const color = z.string().regex(/^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i, "Expected a hex color.");

export const DEFAULT_BRAND_ASSETS = {
  icon: {
    light: "@dbx-tools/ui-branding/assets/icon-light.svg",
    dark: "@dbx-tools/ui-branding/assets/icon-dark.svg",
  },
  logo: {
    light: "@dbx-tools/ui-branding/assets/logo-light.svg",
    dark: "@dbx-tools/ui-branding/assets/logo-dark.svg",
  },
  favicon: "@dbx-tools/ui-branding/assets/icon-light.svg",
} as const;

export const BrandAssetSetSchema = z
  .object({
    light: nonBlankString.describe("Asset for light surfaces."),
    dark: nonBlankString.optional().describe("Asset for dark surfaces; light is the fallback."),
  })
  .strict()
  .describe("Theme-aware references to one visual asset.");

export const BrandColorsSchema = z
  .object({
    primary: color.default("#FF3621").describe("Primary action and identity color."),
    primaryHover: color.default("#D92D18").describe("Primary hover or pressed color."),
    accent: color.default("#00A972").describe("Secondary accent color."),
    foreground: color.default("#0B2026").describe("Default text and mark color."),
    background: color.default("#FFFFFF").describe("Default page background."),
    surface: color.default("#F6F7F8").describe("Secondary surface background."),
    muted: color.default("#5F6B70").describe("Muted text color."),
    border: color.default("#DCE2E5").describe("Default border color."),
  })
  .strict()
  .prefault({});

export const BrandVoiceSchema = z
  .object({
    audience: z
      .array(nonBlankString)
      .default(["Databricks developers", "application engineers", "AI agents"]),
    tone: z.array(nonBlankString).default(["direct", "practical", "technical", "approachable"]),
    principles: z
      .array(nonBlankString)
      .default([
        "Lead with the useful outcome.",
        "Prefer concrete examples and accurate technical language.",
        "Keep product claims specific and defensible.",
      ]),
    avoid: z
      .array(nonBlankString)
      .default(["unsupported superlatives", "vague AI claims", "unnecessary jargon"]),
  })
  .strict()
  .prefault({});

export const BrandContextSchema = z
  .object({
    schemaVersion: z.literal("1").default("1"),
    name: nonBlankString.default("dbx tools").describe("Canonical display name."),
    shortName: nonBlankString.default("dbx").describe("Compact name for constrained UI."),
    tagline: nonBlankString
      .default("Practical tools for Databricks builders.")
      .describe("Short product line suitable for a header or metadata."),
    description: nonBlankString
      .default(
        "Companion packages for Databricks developers building apps, agents, data workflows, and reusable UI.",
      )
      .describe("Plain-language product description."),
    assets: z
      .object({
        icon: BrandAssetSetSchema.default(DEFAULT_BRAND_ASSETS.icon),
        logo: BrandAssetSetSchema.default(DEFAULT_BRAND_ASSETS.logo),
        favicon: nonBlankString.default(DEFAULT_BRAND_ASSETS.favicon),
      })
      .strict()
      .default(DEFAULT_BRAND_ASSETS),
    colors: BrandColorsSchema,
    typography: z
      .object({
        sans: nonBlankString.default("Inter, ui-sans-serif, system-ui, sans-serif"),
        mono: nonBlankString.default("ui-monospace, SFMono-Regular, Menlo, monospace"),
      })
      .strict()
      .prefault({}),
    voice: BrandVoiceSchema,
    links: z
      .object({
        website: z.string().url().optional(),
        repository: z.string().url().optional(),
        documentation: z.string().url().optional(),
      })
      .strict()
      .default({}),
    extensions: z
      .record(nonBlankString, z.unknown())
      .default({})
      .describe("Namespaced consumer-specific values that do not belong in the portable core."),
  })
  .strict()
  .describe("Portable identity, visual, and voice context for UI, libraries, and LLMs.");

export type BrandContext = z.output<typeof BrandContextSchema>;
export type BrandContextInput = z.input<typeof BrandContextSchema>;
export type BrandAssetSet = z.output<typeof BrandAssetSetSchema>;

/** Validate input and fill every dbx tools default. */
export function parseBrandContext(input: unknown = {}): BrandContext {
  return BrandContextSchema.parse(input);
}

export const defaultBrandContext: BrandContext = parseBrandContext();

/** JSON Schema representation suitable for structured-output and tool definitions. */
export function brandContextJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(BrandContextSchema) as Record<string, unknown>;
}

/** Stable prompt block for an LLM that needs to write or design in this brand. */
export function brandContextPrompt(context: BrandContext = defaultBrandContext): string {
  return [
    `Use the following ${context.name} brand context for names, visual choices, and writing voice.`,
    "Treat explicit task instructions as higher priority than this context.",
    "",
    JSON.stringify(context, null, 2),
  ].join("\n");
}
