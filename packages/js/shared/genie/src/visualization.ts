import { z } from "zod";

/** Identifiers required to download a Genie-rendered visualization. */
export const GenieVisualizationRequestSchema = z
  .object({
    space_id: z.string().trim().min(1).describe("Genie space ID."),
    conversation_id: z.string().trim().min(1).describe("Genie conversation ID."),
    message_id: z.string().trim().min(1).describe("Genie message ID."),
    attachment_id: z
      .string()
      .trim()
      .min(1)
      .describe("Visualization attachment ID, not its query ID."),
  })
  .strict()
  .describe("Genie visualization download identifiers.");

/** Identifiers required to download a Genie-rendered visualization. */
export type GenieVisualizationRequest = z.infer<typeof GenieVisualizationRequestSchema>;

/** Build the workspace-relative binary visualization download endpoint. */
export function genieVisualizationDownloadPath(input: GenieVisualizationRequest): string {
  const request = GenieVisualizationRequestSchema.parse(input);
  return `/api/2.0/genie/spaces/${encodeURIComponent(request.space_id)}/conversations/${encodeURIComponent(request.conversation_id)}/messages/${encodeURIComponent(request.message_id)}/attachments/${encodeURIComponent(request.attachment_id)}/download-visualization`;
}
