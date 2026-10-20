/**
 * `dbx brand` option contracts.
 *
 * @module
 */

import { DatabricksAuthOptionsSchema } from "@dbx-tools/auth";
import { z } from "zod";

/** Options for exporting one researched brand package. */
export const BrandExportOptionsSchema = z
  .object({
    profile: DatabricksAuthOptionsSchema.shape.profile,
    name: z.string().trim().min(1).optional().describe("Known canonical brand name."),
    website: z.string().url().optional().describe("Known official HTTPS website."),
    output: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Persistent output directory for brand.yaml, showcase, provenance, and visual references. Omit for a temporary directory.",
      ),
    model: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Optional Databricks model preference for brand synthesis."),
    maxSources: z.coerce
      .number()
      .int()
      .min(1)
      .max(8)
      .default(4)
      .describe("Maximum general web sources to read."),
    sourceMaxLength: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(20_000)
      .default(8_000)
      .describe("Maximum characters retained from each source page."),
    showcase: z
      .boolean()
      .default(true)
      .describe("Responsive HTML brand presentation and website mockups."),
    force: z.boolean().default(false).describe("Replace files in an existing output directory."),
  })
  .strict()
  .describe("Options for exporting a researched brand package.");

/** Resolved brand export options. */
export type BrandExportOptions = z.output<typeof BrandExportOptionsSchema>;
