/**
 * Model-facing profile contract and AppKit tool description for researched
 * brand generation. Browser-safe request, event, and package contracts are
 * owned by `@dbx-tools/shared-generator`.
 *
 * @module
 */

import { stringUtils } from "@dbx-tools/shared-core";
import type { BrandGenerationRequest as SharedBrandGenerationRequest } from "@dbx-tools/shared-generator/brand";
import { z } from "zod";

export {
  BrandGenerationErrorEventSchema,
  BrandGenerationEventSchema,
  BrandGenerationProgressEventSchema,
  BrandGenerationRequestSchema,
  BrandGenerationResultEventSchema,
  BrandGenerationStageSchema,
  BrandPackageSchema,
  BrandPackageSourceSchema,
  BrandVisualImageSchema,
  BrandVisualReferenceSchema,
} from "@dbx-tools/shared-generator/brand";
export type {
  BrandGenerationErrorEvent,
  BrandGenerationEvent,
  BrandGenerationProgressEvent,
  BrandGenerationRequest,
  BrandGenerationResultEvent,
  BrandGenerationStage,
  BrandPackage,
  BrandPackageSource,
  BrandVisualImage,
  BrandVisualReference,
} from "@dbx-tools/shared-generator/brand";

const nonBlankString = z.string().trim().min(1);
const color = z.string().regex(/^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i, "Expected a hex color.");

/** Resolve the human-readable subject from a validated brand request. */
export function brandRequestSubject(request: SharedBrandGenerationRequest): string {
  return request.name ?? request.prompt!;
}

/** Description shared by the native AppKit brand-generation tool. */
export const GENERATE_BRAND_TOOL_DESCRIPTION = stringUtils.toDescription(`
  Research a named organization or product on the web and generate a portable
  branding package. The result includes a validated BrandContext for
  application and email presentation plus the sources used. Supply the
  official website when known to disambiguate brands with similar names.
`);

/**
 * Structured model output before deterministic asset references and schema
 * metadata are attached.
 */
export const GeneratedBrandProfileSchema = z
  .object({
    name: nonBlankString.describe("Canonical display name supported by the sources."),
    shortName: nonBlankString.describe("Compact brand name suitable for constrained UI."),
    tagline: nonBlankString.describe("Short brand line suitable for a header or metadata."),
    description: nonBlankString.describe("Plain-language description of the brand."),
    colors: z
      .object({
        primary: color.describe("Primary identity color."),
        primaryHover: color.describe("Accessible hover or pressed color for the primary color."),
        accent: color.describe("Secondary accent color."),
        foreground: color.describe("Default high-contrast text and mark color."),
        background: color.describe("Default page background."),
        surface: color.describe("Secondary surface background."),
        muted: color.describe("Muted text color with readable contrast."),
        border: color.describe("Default border color."),
      })
      .strict()
      .describe("Usable interface palette based on the researched identity."),
    typography: z
      .object({
        sans: nonBlankString.describe("CSS font-family stack for normal interface text."),
        mono: nonBlankString.describe("CSS font-family stack for code and tabular text."),
      })
      .strict()
      .describe("Brand-compatible CSS font stacks."),
    voice: z
      .object({
        audience: z
          .array(nonBlankString)
          .describe("Primary audiences explicitly supported by the sources."),
        tone: z.array(nonBlankString).describe("Concise descriptors for the brand's writing tone."),
        principles: z
          .array(nonBlankString)
          .describe("Concrete rules for writing in the brand voice."),
        avoid: z.array(nonBlankString).describe("Writing patterns the brand should avoid."),
      })
      .strict()
      .describe("Evidence-based writing voice guidance."),
    links: z
      .object({
        website: z.string().url().describe("Official brand website."),
        repository: z.string().url().optional().describe("Official source repository, if any."),
        documentation: z
          .string()
          .url()
          .optional()
          .describe("Official documentation site, if distinct from the website."),
      })
      .strict()
      .describe("Verified first-party brand links."),
  })
  .strict()
  .describe("Evidence-based brand profile produced by the synthesis model.");

/** Structured model output before deterministic package assembly. */
export type GeneratedBrandProfile = z.infer<typeof GeneratedBrandProfileSchema>;
