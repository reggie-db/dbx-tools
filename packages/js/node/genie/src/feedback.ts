/**
 * Genie message feedback for chat-mode and agent-mode conversations.
 *
 * @module
 */

import { createWorkspaceClient, type WorkspaceClient } from "@databricks/appkit";
import { databricks } from "@dbx-tools/appkit";
import { genieModel, type GenieMessageFeedbackRequest } from "@dbx-tools/shared-genie";

/** Options for one identity-scoped Genie feedback write. */
export interface SendGenieMessageFeedbackOptions {
  /** Workspace client whose identity submits the feedback. */
  workspaceClient?: WorkspaceClient;
  /** External cancellation. */
  context?: databricks.ContextLike;
}

/** Send rating and optional comment directly to one Genie message. */
export async function sendGenieMessageFeedback(
  input: GenieMessageFeedbackRequest,
  options?: SendGenieMessageFeedbackOptions,
): Promise<void> {
  const request = genieModel.GenieMessageFeedbackRequestSchema.parse(input);
  const client = options?.workspaceClient ?? createWorkspaceClient();
  const context = options?.context ? databricks.toContext(options.context) : undefined;
  await client.apiClient.request(
    {
      path: `/api/2.0/genie/spaces/${encodeURIComponent(request.space_id)}/conversations/${encodeURIComponent(request.conversation_id)}/messages/${encodeURIComponent(request.message_id)}/feedback`,
      method: "POST",
      payload: {
        rating: request.rating,
        ...(request.comment ? { comment: request.comment } : {}),
      },
      headers: new Headers(),
      raw: false,
    },
    context,
  );
}
