import { GenieVisualizationRequestSchema } from "@dbx-tools/shared-genie";
import { z } from "zod";
import { genieRoutePath, MASTRA_ROUTES } from "./routes.ts";

/** Direct Genie chart renderer. Image mode uses the upstream PNG unchanged. */
export const GenieVisualizationModeSchema = z
  .enum(["appkit", "image"])
  .describe("Direct Genie chart renderer: inferred AppKit chart or original Genie PNG.");

/** Direct Genie chart renderer. */
export type GenieVisualizationMode = z.infer<typeof GenieVisualizationModeSchema>;

/** Durable image reference stored in direct Genie answer markers. */
export const GenieVisualizationEmbedSchema = GenieVisualizationRequestSchema.omit({
  space_id: true,
})
  .extend({
    alias: z.string().trim().min(1).describe("Configured Genie space alias."),
    statementId: z.string().uuid().describe("Query statement backing the Table tab."),
  })
  .describe("Original Genie visualization and its backing statement.");

/** Original Genie visualization and its backing statement. */
export type GenieVisualizationEmbed = z.infer<typeof GenieVisualizationEmbedSchema>;

/** Marker kind for an original Genie image with a linked query table. */
export const GENIE_VISUALIZATION_MARKER = "genie-visualization";

/** Encode an image reference as one whitespace-free embed marker identifier. */
export function encodeGenieVisualizationEmbed(reference: GenieVisualizationEmbed): string {
  return encodeURIComponent(JSON.stringify(GenieVisualizationEmbedSchema.parse(reference)));
}

/** Read a native image marker, ignoring malformed or fabricated references. */
export function parseGenieVisualizationEmbed(id: string): GenieVisualizationEmbed | undefined {
  try {
    const parsed = GenieVisualizationEmbedSchema.safeParse(JSON.parse(decodeURIComponent(id)));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Build the mount-relative OBO image route from a durable visualization reference. */
export function genieVisualizationImagePath(reference: GenieVisualizationEmbed): string {
  return genieRoutePath(
    reference.alias,
    MASTRA_ROUTES.threads,
    reference.conversation_id,
    MASTRA_ROUTES.messages,
    reference.message_id,
    MASTRA_ROUTES.attachments,
    reference.attachment_id,
    MASTRA_ROUTES.visualization,
  );
}
